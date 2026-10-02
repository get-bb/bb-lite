import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { RpcError } from "@bb/plugin";
import {
  pluginCliRequestSchema,
  pluginMentionSearchQuerySchema,
  pluginSettingsUpdateRequestSchema,
  pluginTokenRequestSchema,
} from "@bb/server-contract";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { contentType } from "mime-types";
import type { z } from "zod";
import type { ServerContext } from "../../context.js";
import type { PluginHost } from "../../plugins/host.js";
import type { PluginInstance } from "../../plugins/instance.js";
import { resolveInside } from "../../plugins/manifest.js";
import type { ApiApp, AppEnv } from "../api.js";
import { ApiError, errorMessage, invalidRequest, notFound } from "../errors.js";
import { requireOwner } from "../trust.js";

type RouteContext = Context<AppEnv>;

const CLI_KEEPALIVE_MS = 10_000;
const ASSET_FILE_PATTERN = /\.(?:svg|png|webp)$/iu;
const IMMUTABLE = "public, max-age=31536000, immutable";

interface RpcOutcome {
  status: ContentfulStatusCode;
  body: { ok: true; result: unknown } | { ok: false; error: RpcError };
}

function parseJson(text: string): unknown {
  try {
    return text.trim() === "" ? null : JSON.parse(text);
  } catch {
    throw invalidRequest("The request body must be JSON");
  }
}

async function jsonBody<T>(c: RouteContext, schema: z.ZodType<T>) {
  const parsed = schema.safeParse(parseJson(await c.req.text()) ?? {});
  if (parsed.success) return parsed.data;
  throw invalidRequest(parsed.error.issues[0]?.message ?? "Invalid request");
}

function rpcError(
  status: ContentfulStatusCode,
  code: RpcError["code"],
  problem: string | z.ZodError,
): RpcOutcome {
  if (typeof problem === "string") {
    return { status, body: { ok: false, error: { code, message: problem } } };
  }
  const issues = problem.issues.map(({ message, path }) => ({ message, path }));
  const error = { code, message: issues[0]?.message ?? code, issues };
  return { status, body: { ok: false, error } };
}

async function callRpc(
  plugins: PluginHost,
  id: string,
  method: string,
  body: string,
): Promise<RpcOutcome> {
  let input: unknown;
  let entry: ReturnType<PluginInstance["rpc"]["get"]>;
  try {
    input = parseJson(body);
    entry = plugins.running(id).rpc.get(method);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const unavailable = error.status !== 400;
    const code = unavailable ? "plugin_unavailable" : "invalid_json";
    return rpcError(error.status, code, error.message);
  }
  if (entry === undefined) {
    const message = `Plugin "${id}" has no rpc method "${method}"`;
    return rpcError(404, "unknown_method", message);
  }
  const accepted = await entry.contract.input.safeParseAsync(input);
  if (!accepted.success) return rpcError(400, "invalid_input", accepted.error);
  let result: unknown;
  try {
    result = await entry.handler(accepted.data);
  } catch (error) {
    return rpcError(500, "handler_error", errorMessage(error));
  }
  const produced = await entry.contract.output.safeParseAsync(result);
  if (!produced.success) return rpcError(500, "invalid_output", produced.error);
  return { status: 200, body: { ok: true, result: produced.data } };
}

function keepAliveJson(result: Promise<unknown>) {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string, last: boolean) => {
        try {
          controller.enqueue(encoder.encode(text));
          if (last) controller.close();
        } catch {
          clearInterval(timer);
        }
      };
      timer = setInterval(() => send("\n", false), CLI_KEEPALIVE_MS);
      void result.then((value) => {
        clearInterval(timer);
        send(JSON.stringify(value), true);
      });
    },
    cancel: () => clearInterval(timer),
  });
  return new Response(body, {
    headers: { "content-type": "application/json" },
  });
}

export function registerPluginRoutes(app: ApiApp, ctx: ServerContext): void {
  const { plugins, log } = ctx;
  const requireManager = (c: RouteContext) =>
    requireOwner(c, "Only the owner can manage plugins");

  app.get("/plugins", (c) => c.json({ plugins: plugins.list() }));

  app.get("/plugins/contributions", (c) => c.json(plugins.contributions()));

  app.get("/plugins/mentions/search", async (c) => {
    const parsed = pluginMentionSearchQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw invalidRequest("Invalid mention search query");
    const { q, trigger, projectId = null, threadId = null } = parsed.data;
    const query = { trigger, query: q.trim(), projectId, threadId };
    return c.json({ ok: true, groups: await plugins.searchMentions(query) });
  });

  app.post("/plugins/reload", async (c) => {
    requireManager(c);
    await plugins.reload(c.req.query("id"));
    return c.json({ ok: true, plugins: plugins.list() });
  });

  for (const action of ["enable", "disable"] as const) {
    app.post(`/plugins/:id/${action}`, async (c) => {
      requireManager(c);
      const enabled = action === "enable";
      const plugin = await plugins.setEnabled(c.req.param("id"), enabled);
      return c.json({ ok: true, plugin });
    });
  }

  app.get("/plugins/:id/settings", async (c) =>
    c.json({ ok: true, ...(await plugins.settings(c.req.param("id"))) }),
  );

  app.put("/plugins/:id/settings", async (c) => {
    requireManager(c);
    const { values } = await jsonBody(c, pluginSettingsUpdateRequestSchema);
    const view = await plugins.settings(c.req.param("id"), values);
    return c.json({ ok: true, ...view });
  });

  app.post("/plugins/:id/token", async (c) => {
    requireManager(c);
    const { rotate } = await jsonBody(c, pluginTokenRequestSchema);
    const token = plugins.token(c.req.param("id"), rotate);
    return c.json({ ok: true, token });
  });

  app.post("/plugins/:id/rpc/:method", async (c) => {
    const { id, method } = c.req.param();
    const outcome = await callRpc(plugins, id, method, await c.req.text());
    if (!outcome.body.ok && outcome.status === 500) {
      log.warn("Plugin rpc failed", { pluginId: id, method, ...outcome.body });
    }
    c.header("cache-control", "no-store");
    return c.json(outcome.body, outcome.status);
  });

  app.post("/plugins/:id/cli", async (c) => {
    const id = c.req.param("id");
    const { argv, ...scope } = await jsonBody(c, pluginCliRequestSchema);
    const run = async () => {
      const { cli } = plugins.running(id);
      if (cli === null) throw new Error(`Plugin "${id}" has no CLI command`);
      const context = { ...scope, signal: c.req.raw.signal };
      const result = await cli.run(argv, context);
      const { exitCode, stdout = "", stderr = "" } = result;
      return { exitCode, stdout, stderr };
    };
    const failed = (error: unknown) => {
      return { exitCode: 1, stdout: "", stderr: `${errorMessage(error)}\n` };
    };
    return keepAliveJson(run().catch(failed));
  });

  app.all("/plugins/:id/http/*", async (c) => {
    const id = c.req.param("id");
    const { method } = c.req;
    const path = c.req.path.slice(`/api/v1/plugins/${id}/http`.length) || "/";
    const route = plugins.running(id).routes.get(`${method} ${path}`);
    if (route === undefined) {
      throw notFound(`Plugin "${id}" has no ${method} route for "${path}"`);
    }
    if (route.auth === "local") {
      requireOwner(c, "This plugin route is owner-only");
    }
    const token = c.req.header("x-bb-plugin-token") ?? c.req.query("token");
    if (route.auth === "token" && !plugins.acceptsToken(id, token)) {
      const message = "Missing or invalid plugin token";
      throw new ApiError(401, "invalid_plugin_token", message);
    }
    return route.handler(c.req.raw);
  });

  app.get("/plugins/:id/:file{app\\.(?:js|css)}", (c) => {
    const { id, file } = c.req.param();
    const bundle = plugins.record(id).app;
    const content = file === "app.js" ? bundle?.js : bundle?.css;
    if (content == null) throw notFound(`Plugin "${id}" has no ${file}`);
    const fresh = c.req.query("h") === bundle?.hash;
    const cacheControl = fresh ? IMMUTABLE : "no-cache";
    const type = contentType(file) || "application/octet-stream";
    return c.body(content, 200, {
      "content-type": type,
      "cache-control": cacheControl,
    });
  });

  app.get("/plugins/:id/assets/*", async (c) => {
    const id = c.req.param("id");
    const { directory } = plugins.record(id).manifest;
    const prefix = `/api/v1/plugins/${id}/assets/`;
    const path = c.req.path.slice(prefix.length);
    const image = ASSET_FILE_PATTERN.test(path);
    const file = image ? resolveInside(directory, path) : null;
    const content = await readFile(file ?? "").catch(() => null);
    if (content === null) throw notFound();
    const type = contentType(extname(path)) || "application/octet-stream";
    const headers = { "content-type": type, "cache-control": "no-cache" };
    return c.body(new Uint8Array(content), 200, headers);
  });
}
