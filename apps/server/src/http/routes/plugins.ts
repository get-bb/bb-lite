import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import {
  pluginCliRequestSchema,
  pluginTokenRequestSchema,
} from "@bb/server-contract";
import type { Context } from "hono";
import { contentType } from "mime-types";
import type { z } from "zod";
import type { HostContext } from "../../host-context.js";
import {
  asPlugin,
  currentCaller,
  enterCaller,
} from "@bb/server-kit/kernel/caller";
import { resolveInside } from "../../plugins/manifest.js";
import type { ApiApp, AppEnv } from "@bb/server-kit/http/api";
import {
  ApiError,
  errorMessage,
  forbidden,
  invalidRequest,
  notFound,
} from "@bb/server-kit/http/errors";
import { requireOwner } from "@bb/server-kit/http/trust";
import { getEnvironment } from "@bb/server-kit/db/environments";
import { getThread } from "@bb/server-kit/db/threads";

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
  const threadHost = (threadId: string | undefined) => {
    const thread =
      threadId === undefined ? undefined : getThread(ctx.db, threadId);
    const environmentId = thread?.environmentId ?? null;
    if (environmentId === null) return undefined;
    return getEnvironment(ctx.db, environmentId)?.hostId;
  };
  const requireManager = () =>
    requireOwner("Only the owner can manage plugins");

  app.post("/plugins/:id/token", async (c) => {
    requireManager();
    const { rotate } = await jsonBody(c, pluginTokenRequestSchema);
    const token = plugins.token(c.req.param("id"), rotate);
    return c.json({ ok: true, token });
  });

  app.post("/plugins/:id/cli", async (c) => {
    const id = c.req.param("id");
    const caller = currentCaller();
    if (caller.role === "machine" && caller.thread === null) {
      throw forbidden(
        "Machine credentials can run plugin commands only for a thread they run",
      );
    }
    const { argv, ...given } = await jsonBody(c, pluginCliRequestSchema);
    const hostId = given.hostId ?? threadHost(given.threadId);
    const scope = hostId === undefined ? given : { ...given, hostId };
    const run = async () => {
      plugins.running(id);
      const cli = plugins.cliOf(id);
      if (cli === null) throw new Error(`Plugin "${id}" has no CLI command`);
      const context = { ...scope, signal: c.req.raw.signal };
      const door = caller.door === "agent" ? "agent" : "cli";
      const claimed = caller.role === "machine" ? null : scope.threadId;
      const thread = caller.thread ?? claimed ?? null;
      const result = await enterCaller({ ...caller, door, thread }, () =>
        asPlugin(id, () => cli.run(argv, context)),
      );
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
    const files = themes.flatMap(({ id, cssFile, codeThemeFiles }) => [
      [`${id}.css`, cssFile, "text/css"],
      ...Object.entries(codeThemeFiles).map(([side, file]) => [
        `${id}.${side}.json`,
        file,
        "application/json",
      ]),
    ]);
    const [, file = "", type] = files.find(([name]) => name === wanted) ?? [];
    const content = await readFile(file).catch(() => null);
    if (content === null || type === undefined) throw notFound();
    const headers = { "content-type": type, "cache-control": "no-cache" };
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
