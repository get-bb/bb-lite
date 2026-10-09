import {
  environments as environmentOps,
  threads as threadOps,
} from "@bb/plugin";
import type { SendMessageRequest } from "@bb/server-contract";
import type { HostContext } from "../src/host-context.js";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  PERSONAL_PROJECT_ID,
  type RealtimeSubscriptionTarget,
} from "@bb/domain";
import {
  createWorkspaceApi,
  MACHINE_OPS,
  opCaller,
  RunnerError,
  type RunnerEventSink,
  type WorkspaceApi,
} from "@bb/runner";
import { createEchoAdapter } from "../../../plugins/provider-echo/runner/echo.js";
import { expect, onTestFinished } from "vitest";
import { WebSocket } from "ws";
import { loadConfig, type ServerConfig } from "@bb/server-kit/config";
import type { ServerRunner } from "@bb/server-kit/context";
import {
  insertRow,
  openDatabase,
  type Db,
  type RowValues,
} from "@bb/server-kit/db/index";
import { setPluginEnabled } from "@bb/server-kit/db/plugins";
import { localRunnerFor } from "@bb/server-kit/runners/local";
import { builtinPlugins } from "../src/plugins/builtin.js";
import { createServer } from "../src/server.js";

export type Json = Record<string, unknown>;
export type SocketMessage = { type: string } & Json;
export type TestServer = Awaited<ReturnType<typeof createTestServer>>;
type Matcher = (message: SocketMessage) => boolean;
type Files = Record<string, string | Uint8Array>;
type RunnerKind = "fake" | "workspace" | "echo";

const NEXT_MESSAGE_TIMEOUT_MS = 2_000;
const JSON_HEADERS = { "content-type": "application/json" };
const LISTS = ["project", "thread", "host", "environment"] as const;
const AT = { createdAt: 1, updatedAt: 1 };

interface Sent {
  param?: Record<string, string>;
  query?: Record<string, unknown>;
  json?: unknown;
}
type Send = (sent?: Sent) => Promise<Response>;
type Verb = "$get" | "$post" | "$put" | "$patch" | "$delete";
type Paths = { [segment: string]: Paths } & Record<Verb, Send>;

function paths(
  request: (path: string, init: RequestInit) => Promise<Response>,
  segments: string[] = [],
): Paths {
  const send = (verb: string, { param = {}, query = {}, json }: Sent) => {
    const filled = segments.map((segment) =>
      segment.startsWith(":")
        ? encodeURIComponent(param[segment.slice(1)] ?? "")
        : segment,
    );
    const given = Object.entries(query).filter(([, value]) => value != null);
    const search = new URLSearchParams(
      given.map(([name, value]) => [name, String(value)]),
    ).toString();
    const path = `/${filled.join("/")}${search === "" ? "" : `?${search}`}`;
    const method = verb.slice(1).toUpperCase();
    if (json === undefined) return request(path, { method });
    const body = JSON.stringify(json);
    return request(path, { method, headers: JSON_HEADERS, body });
  };
  return new Proxy({} as Paths, {
    get: (_target, key: string) =>
      key.startsWith("$")
        ? (sent: Sent = {}) => send(key, sent)
        : paths(request, [...segments, key]),
  });
}

type Scripted = Omit<ServerRunner, "call"> & WorkspaceApi;

export class FakeRunner {
  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly script: Partial<Scripted> = { ackEvents: async () => {} };
  emit: RunnerEventSink = () => {};
  readonly api = new Proxy({} as ServerRunner, {
    get: (_target, method) =>
      method === "call"
        ? opCaller((sent) => {
            const machine = MACHINE_OPS.find(({ name }) => name === sent.name);
            if (machine === undefined) return this.call("callOp", sent);
            return this.call(machine.method, sent.input);
          })
        : this.call.bind(this, String(method)),
  });

  private call(method: string, ...args: unknown[]): Promise<unknown> {
    this.calls.push({ method, args });
    const scripted: unknown = Reflect.get(this.script, method);
    if (typeof scripted === "function") {
      return Promise.resolve(scripted(...args) as unknown);
    }
    const message = `FakeRunner.${method} is not scripted`;
    return Promise.reject(new RunnerError("failed", message));
  }
}

export class TestSocket {
  readonly presence: SocketMessage[] = [];
  private readonly inbox: SocketMessage[] = [];
  private wake = (): void => {};

  constructor(readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as SocketMessage;
      const lane = message.type === "presence" ? this.presence : this.inbox;
      lane.push(message);
      this.wake();
    });
  }

  async next(
    matches: Matcher = () => true,
    timeoutMs = NEXT_MESSAGE_TIMEOUT_MS,
  ): Promise<SocketMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.inbox.findIndex(matches);
      const [found] = index < 0 ? [] : this.inbox.splice(index, 1);
      if (found !== undefined) return found;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("No matching socket message arrived");
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        setTimeout(resolve, remaining);
      });
    }
  }

  send(message: object): void {
    this.socket.send(JSON.stringify(message));
  }

  async subscribe(target: RealtimeSubscriptionTarget): Promise<void> {
    this.send({ type: "subscribe", target });
    this.send({ type: "ping" });
    await this.next((message) => message.type === "pong");
  }
}

export const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: "1",
};

export function scratch(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "bb-test-")));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

export function git(cwd: string, ...args: string[]): string {
  const options = { cwd, env: GIT_ENV, encoding: "utf8" } as const;
  return execFileSync("git", args, options).trim();
}

export function write(root: string, files: Files): void {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
}

export function commitAll(repo: string): void {
  git(repo, "init", "--quiet", "-b", "main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "initial");
}

function localRunner(kind: RunnerKind, config: ServerConfig, fake: FakeRunner) {
  if (kind === "echo") {
    const local = localRunnerFor(config, { adapters: [createEchoAdapter()] });
    onTestFinished(local.shutdown);
    return local.connect;
  }
  if (kind === "workspace") {
    const workspace = createWorkspaceApi({
      dataDir: config.dataDir,
      env: async () => GIT_ENV,
      sink: (event) => void (event.lane === "live" && fake.emit(event)),
    });
    Object.assign(fake.script, workspace.api);
    onTestFinished(() => workspace.dispose());
  }
  return (sink: RunnerEventSink) => {
    fake.emit = sink;
    return fake.api;
  };
}

function facades({ kernel }: HostContext) {
  const threads = {
    get: (threadId: string) =>
      kernel.call(threadOps.get, { threadId }).catch(() => null),
    send: (threadId: string, request: SendMessageRequest) =>
      kernel.call(threadOps.send, { threadId, ...request }),
    stop: (threadId: string) => kernel.call(threadOps.stop, { threadId }),
    archive: async (threadId: string) =>
      (await kernel.call(threadOps.archive, { threadId })).archivedThreadIds,
    unarchive: (threadId: string) =>
      kernel.call(threadOps.unarchive, { threadId }),
    delete: (threadId: string, confirmed: { childThreadsConfirmed: boolean }) =>
      kernel.call(threadOps.delete, { threadId, ...confirmed }),
    settled: () => kernel.call(threadOps.waitSettled, {}),
    sweep: () => kernel.call(threadOps.sweep, {}),
  };
  const environments = {
    workspaceInstructions: (environmentId: string) =>
      kernel.call(environmentOps.instructions, { environmentId }),
    sweep: () => kernel.call(environmentOps.sweep, {}),
    remove: (environmentId: string) =>
      kernel.call(environmentOps.delete, { environmentId }),
  };
  return { threads, environments };
}

const BASELINE = [
  "provider-codex",
  "provider-claude-code",
  "provider-echo",
  "environment-project-checkout",
  "environment-git-worktree",
  "environment-personal-workspace",
  "thread-list",
  "navigation",
  "secrets",
  "ask-user-question",
  "custom-instructions",
  "connect",
  "audit",
  "plugin-dev",
  "account-pool",
  "tasks",
];

function requiredBy(id: string, seen: string[] = []): string[] {
  if (seen.includes(id)) return seen;
  const file = new URL(`../../../plugins/${id}/package.json`, import.meta.url);
  const manifest = JSON.parse(readFileSync(file, "utf8")) as {
    bb?: { requires?: string[] | Record<string, string> };
  };
  const requires = manifest.bb?.requires ?? [];
  const needed = Array.isArray(requires) ? requires : Object.keys(requires);
  return needed.reduce((found, next) => requiredBy(next, found), [...seen, id]);
}

function pluginsUnderTest(
  wanted: "all" | readonly string[] | undefined,
  db: Db,
) {
  if (wanted === "all") return builtinPlugins;
  const path = expect.getState().testPath ?? "";
  const own = /[\\/]plugins[\\/]([^\\/]+)[\\/]test[\\/]/u.exec(path)?.[1];
  const named = wanted ?? (own === undefined ? [] : [own]);
  const ids = named.reduce((found, id) => requiredBy(id, found), BASELINE);
  for (const id of named) setPluginEnabled(db, id, true);
  return builtinPlugins.filter(({ directory }) =>
    ids.includes(basename(directory)),
  );
}

export async function createTestServer(
  overrides: Partial<ServerConfig> = {},
  kind: RunnerKind = "fake",
  databasePath = ":memory:",
  plugins?: "all" | readonly string[],
) {
  const dataDir = scratch();
  const env = { BB_DATA_DIR: dataDir, BB_SERVER_PORT: "0" };
  const logLevel = "silent" as const;
  const config = { ...loadConfig(env), logLevel, ...overrides };
  const clock = { now: 1_700_000_000_000 };
  const now = () => clock.now;
  const runner = new FakeRunner();
  const db = openDatabase({ path: databasePath, now });
  const connect = localRunner(kind, config, runner);
  const tunnelToken = "1";
  const wiring = { config, now, db, tunnelToken };
  const builtins = pluginsUnderTest(plugins, db);
  const server = createServer({ ...wiring, localRunner: connect, builtins });
  const { url } = await server.listen();
  onTestFinished(() => server.close());
  const request = (path: string, init: RequestInit = {}) =>
    fetch(`${url}/api/v1${path}`, init);
  const send = (path: string, json: unknown, method = "POST", extra = {}) => {
    const headers = { ...JSON_HEADERS, ...extra };
    return request(path, { method, headers, body: JSON.stringify(json) });
  };
  const read = async <Body = Json>(path: string) =>
    (await (await request(path)).json()) as Body;
  return {
    ctx: Object.assign(server.ctx, facades(server.ctx)),
    url,
    api: paths(request),
    runner,
    clock,
    request,
    send,
    read,
    matches: async (path: string, shape: object) =>
      expect(await read(path), path).toMatchObject(shape),
    socket: (path = "/ws"): Promise<TestSocket> =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(`${url.replace("http", "ws")}${path}`);
        socket.on("open", () => resolve(new TestSocket(socket)));
        socket.on("error", reject);
      }),
  };
}

export async function watchChanges(server: TestServer) {
  const client = await server.socket();
  await client.subscribe({ kind: "system" });
  for (const list of LISTS) await client.subscribe({ kind: `${list}-list` });
  return (entity: string, ...kinds: string[]) =>
    client.next(({ entity: changed, changes }) => {
      const sent = changes as string[];
      return changed === entity && kinds.every((kind) => sent.includes(kind));
    });
}

export function insertThread(
  { ctx }: TestServer,
  id: string,
  projectId: string = PERSONAL_PROJECT_ID,
  columns: RowValues = {},
): void {
  const thread = { id, projectId, providerId: "echo", latestAttentionAt: 1 };
  insertRow(ctx.db, "threads", { ...thread, ...AT, ...columns });
}

export function insertEnvironment(
  { ctx }: TestServer,
  environment: Record<"id" | "projectId" | "hostId" | "path", string>,
  isGitRepo = 1,
): void {
  const kind = { status: "ready", environmentProviderId: "project-checkout" };
  const row = { ...environment, isGitRepo, ...kind, ...AT };
  insertRow(ctx.db, "environments", row);
}

export async function createProject(
  { api, ctx }: TestServer,
  name: string,
  path = `/repos/${name}`,
) {
  const { hostId } = ctx.config;
  const source = { type: "local_path" as const, hostId, path };
  return (await api.projects.$post({ json: { name, source } })).json();
}

export async function createEchoServer() {
  const server = await createTestServer({}, "echo");
  const directory = join(server.ctx.config.dataDir, "repo");
  mkdirSync(directory);
  const project = await createProject(server, "echo", directory);
  return { ...server, directory, project };
}

export async function createDemo() {
  const server = await createTestServer({}, "workspace");
  const repo = scratch();
  write(repo, {
    "README.md": "# demo\n",
    "src/a.ts": "export const a = 1;\n",
    "src/index.html": "<p>hi</p>\n",
    ".bb/skills/ship/SKILL.md": "---\ndescription: Ship it\n---\n",
  });
  commitAll(repo);
  const { hostId } = server.ctx.config;
  const { id: projectId } = await createProject(server, "demo", repo);
  insertEnvironment(server, { id: "env_demo", projectId, hostId, path: repo });
  return { ...server, server, repo, projectId, hostId };
}
