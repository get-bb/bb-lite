import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import {
  pluginCliRequestSchema,
  pluginSettingsUpdateRequestSchema,
  pluginTokenRequestSchema,
} from "@bb/server-contract";
import type { Context } from "hono";
import { contentType } from "mime-types";
import type { z } from "zod";
import { actorUserId } from "@bb/server-kit/auth/actor";
import type { HostContext } from "../../host-context.js";
import { asPlugin } from "@bb/server-kit/kernel/caller";
import { resolveInside } from "../../plugins/manifest.js";
import type { ApiApp, AppEnv } from "@bb/server-kit/http/api";
import {
  ApiError,
  errorMessage,
  invalidRequest,
  notFound,
} from "@bb/server-kit/http/errors";
import { requireOwner } from "@bb/server-kit/http/trust";

type RouteContext = Context<AppEnv>;

const CLI_KEEPALIVE_MS = 10_000;
const ASSET_FILE_PATTERN = /\.(?:svg|png|webp)$/iu;
const IMMUTABLE = "public, max-age=31536000, immutable";

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

export function registerPluginRoutes(app: ApiApp, shared: HostContext): void {
  const ctx = shared as HostContext;
  const { plugins } = ctx;
  const requireManager = (c: RouteContext) =>
    requireOwner("Only the owner can manage plugins");

  app.get("/plugins", (c) => c.json({ plugins: plugins.list() }));

  app.get("/plugins/contributions", (c) => c.json(plugins.contributions()));

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

  app.get("/plugins/:id/settings", async (c) => {
    const id = c.req.param("id");
    const view = await plugins.settings(id, undefined, actorUserId());
    return c.json({ ok: true, ...view });
  });

  app.put("/plugins/:id/settings", async (c) => {
    const id = c.req.param("id");
    const { values } = await jsonBody(c, pluginSettingsUpdateRequestSchema);
    const personal = plugins.hasPersonalSettings(id, Object.keys(values));
    if (!personal) requireManager(c);
    const view = await plugins.settings(id, values, actorUserId());
    return c.json({ ok: true, ...view });
  });

  app.post("/plugins/:id/token", async (c) => {
    requireManager(c);
    const { rotate } = await jsonBody(c, pluginTokenRequestSchema);
    const token = plugins.token(c.req.param("id"), rotate);
    return c.json({ ok: true, token });
  });

  app.post("/plugins/:id/cli", async (c) => {
    const id = c.req.param("id");
    const { argv, ...scope } = await jsonBody(c, pluginCliRequestSchema);
    const run = async () => {
      plugins.running(id);
      const cli = plugins.cliOf(id);
      if (cli === null) throw new Error(`Plugin "${id}" has no CLI command`);
      const context = { ...scope, signal: c.req.raw.signal };
      const result = await asPlugin(id, () => cli.run(argv, context));
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
      requireOwner("This plugin route is owner-only");
    }
    const token = c.req.header("x-bb-plugin-token") ?? c.req.query("token");
    if (route.auth === "token" && !plugins.acceptsToken(id, token)) {
      const message = "Missing or invalid plugin token";
      throw new ApiError(401, "invalid_plugin_token", message);
    }
    return route.handler(c.req.raw);
  });

  app.get("/plugin-utilities.css", (c) => {
    const sheet = plugins.utilities;
    if (sheet === null) throw notFound("No plugin adds styles");
    const fresh = c.req.query("h") === sheet.hash;
    return c.body(sheet.css, 200, {
      "content-type": "text/css; charset=utf-8",
      "cache-control": fresh ? IMMUTABLE : "no-cache",
    });
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

  app.get("/plugins/:id/themes/:theme", async (c) => {
    const { themes } = plugins.record(c.req.param("id")).manifest;
    const wanted = c.req.param("theme");
    const theme = themes.find(({ id }) => `${id}.css` === wanted);
    const content = await readFile(theme?.cssFile ?? "").catch(() => null);
    if (content === null) throw notFound();
    const headers = { "content-type": "text/css", "cache-control": "no-cache" };
    return c.body(new Uint8Array(content), 200, headers);
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
