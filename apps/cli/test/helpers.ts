import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { createEchoAdapter } from "@bb/runner";
import { onTestFinished } from "vitest";
import type { ServerConfig } from "../../server/src/config.js";
import type { ServerContext } from "../../server/src/context.js";
import { lastAssistantText } from "../../server/src/db/events.js";
import { localRunnerFor } from "../../server/src/runners/local.js";
import { createTestServer } from "../../server/test/helpers.js";
import { createProject } from "../../server/test/watch.js";

interface StoredEvent {
  id: string;
  sequence: number;
  type: string;
  data: string;
  createdAt: number;
  scopeKind: string;
}

export interface BbResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const at = (path: string): string =>
  fileURLToPath(new URL(path, import.meta.url));
const ENTRY = at("../src/index.ts");
const TSX_LOADER = at("../../../node_modules/tsx/dist/loader.mjs");
const NODE_ARGS = ["--conditions=source", "--import", TSX_LOADER, ENTRY];
const THREAD_READ =
  /^\/api\/v1\/threads(?:\/(thr_\w+)(?:\/(output|events))?)?$/u;
const JSON_TYPE = { "content-type": "application/json" };
const NOT_FOUND = { code: "thread_not_found", message: "Thread not found" };

export async function runBb(
  args: string[],
  env: Record<string, string> = {},
  stdin = "",
): Promise<BbResult> {
  const { PATH = "", HOME = "" } = process.env;
  const options = {
    env: { PATH, HOME, BB_SERVER_URL: "http://127.0.0.1:9", ...env },
  };
  const child = spawn(process.execPath, [...NODE_ARGS, ...args], options);
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => (output.stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (output.stderr += String(chunk)));
  child.stdin.end(stdin);
  const [code] = (await once(child, "close")) as [number | null];
  return { code, ...output };
}

function readThreads(ctx: ServerContext, url: URL): unknown {
  const [, id, view] = THREAD_READ.exec(url.pathname) ?? [];
  if (id === undefined) {
    const parent = url.searchParams.get("parentThreadId");
    const rows = ctx.db.all<{ id: string }>(
      "SELECT id FROM threads WHERE parent_thread_id IS ? ORDER BY created_at",
      parent,
    );
    return rows.map((row) => ctx.threads.get(row.id));
  }
  if (view === "output") return { output: lastAssistantText(ctx.db, id) };
  if (view === undefined) return ctx.threads.get(id);
  const after = Number(url.searchParams.get("afterSeq") ?? -1);
  const events = ctx.db.all<StoredEvent>(
    `SELECT id, sequence, type, data, created_at, scope_kind FROM events
     WHERE thread_id = ? AND sequence > ? ORDER BY sequence LIMIT 100`,
    id,
    after,
  );
  return events.map(({ sequence: seq, data, scopeKind, ...event }) => {
    const scope = { kind: scopeKind };
    return { ...event, seq, threadId: id, scope, data: JSON.parse(data) };
  });
}

function standInForThreadReadRoutes(
  ctx: ServerContext,
  origin: string,
): Server {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", origin);
    if (request.method === "GET" && THREAD_READ.test(url.pathname)) {
      const found = readThreads(ctx, url);
      response.writeHead(found === null ? 404 : 200, JSON_TYPE);
      return response.end(JSON.stringify(found ?? NOT_FOUND));
    }
    const sent = await buffer(request);
    const forwarded = await fetch(url, {
      method: request.method,
      headers: { "content-type": request.headers["content-type"] ?? "" },
      body: sent.length === 0 ? undefined : sent,
    });
    const type = forwarded.headers.get("content-type") ?? "";
    response.writeHead(forwarded.status, { "content-type": type });
    response.end(Buffer.from(await forwarded.arrayBuffer()));
  });
}

export async function startBb() {
  const localRunner = (config: ServerConfig) => {
    const local = localRunnerFor(config, [createEchoAdapter()]);
    onTestFinished(local.shutdown);
    return local.connect;
  };
  const server = await createTestServer({}, { localRunner });
  const { ctx } = server;
  const directory = join(ctx.config.dataDir, "repo");
  mkdirSync(directory);
  const project = await createProject(server, "cli", directory);
  const standIn = standInForThreadReadRoutes(ctx, server.url).listen(0);
  await once(standIn, "listening");
  onTestFinished(() => void standIn.close());
  const { port } = standIn.address() as AddressInfo;
  const BB_SERVER_URL = `http://127.0.0.1:${port}`;
  const bb = (args: string[], env: Record<string, string> = {}, stdin = "") =>
    runBb(args, { BB_SERVER_URL, BB_PROJECT_ID: project.id, ...env }, stdin);
  return { ctx, project, bb };
}

export function parsed<Shape>(result: BbResult): Shape {
  return JSON.parse(result.stdout) as Shape;
}
