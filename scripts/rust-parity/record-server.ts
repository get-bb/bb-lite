import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Json = any;

for (const key of Object.keys(process.env)) {
  if (/^(BB_|ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_|GIT_)/.test(key)) {
    delete process.env[key];
  }
}
const root = fileURLToPath(new URL("../..", import.meta.url));
const outDir =
  process.argv[2] ?? join(root, "crates/bb-server/tests/fixtures/parity");
const temp = realpathSync(mkdtempSync(join(tmpdir(), "bb-parity-")));
const dataDir = join(temp, "data");
const repo = join(temp, "repo");
const home = join(temp, "home");
for (const dir of [dataDir, repo, home]) mkdirSync(dir, { recursive: true });
Object.assign(process.env, {
  HOME: home,
  VITEST: "1",
  BB_DATA_DIR: dataDir,
  BB_SERVER_PORT: "0",
  BB_DEV_PROVIDERS: "echo",
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Parity",
  GIT_AUTHOR_EMAIL: "parity@example.com",
  GIT_COMMITTER_NAME: "Parity",
  GIT_COMMITTER_EMAIL: "parity@example.com",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
});
const HOST_ID = "host_parity000000";
writeFileSync(join(dataDir, "host-id"), `${HOST_ID}\n`);

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
writeFileSync(join(repo, "README.md"), "# parity repo\n");
mkdirSync(join(repo, "src"));
writeFileSync(join(repo, "src/a.ts"), "export const a = 1;\n");
git("init", "--quiet", "-b", "main");
git("add", "-A");
git("commit", "--quiet", "-m", "initial");

const { loadConfig } = await import("../../apps/server/src/config.js");
const { createServer } = await import("../../apps/server/src/server.js");
const { localRunnerFor } =
  await import("../../apps/server/src/runners/local.js");
const { listEvents, decodeEvents } =
  await import("../../apps/server/src/db/event-read.js");
const { createEchoAdapter } =
  await import("../../packages/runner/src/index.js");

const BASE_TIME = 1_800_000_000_000;
let clock = BASE_TIME;
const config = { ...loadConfig(process.env), logLevel: "silent" as const };
const local = localRunnerFor(config, [createEchoAdapter()]);
const server = createServer({
  config,
  now: () => clock,
  localRunner: local.connect,
});
const { url } = await server.listen();
const { ctx } = server;

const steps: Json[] = [];
let scenario = "";
let stepNo = 0;
const sanitize = (value: unknown): Json =>
  value === undefined
    ? null
    : JSON.parse(
        JSON.stringify(value)
          .replaceAll(dataDir, "$DATA_DIR")
          .replaceAll(repo, "$REPO")
          .replaceAll(temp, "$TEMP")
          .replaceAll(url.replace("http://", ""), "$SERVER_HOST"),
      );
const record = (entry: Json) =>
  steps.push(sanitize({ scenario, step: ++stepNo, ...entry }));

async function http(
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string>,
  prefix = "/api/v1",
): Promise<{ status: number; body: Json }> {
  clock += 1000;
  const target = new URL(`${url}${prefix}${path}`);
  for (const [k, v] of Object.entries(query ?? {}))
    target.searchParams.set(k, v);
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const res = await fetch(target, init);
  const type = res.headers.get("content-type") ?? "";
  const bytes = Buffer.from(await res.arrayBuffer());
  let parsed: Json = null;
  if (bytes.length > 0) {
    if (type.includes("json")) parsed = JSON.parse(bytes.toString("utf8"));
    else {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      parsed = { contentType: type, length: bytes.length, sha256 };
    }
  }
  record({
    kind: "http",
    request: {
      method,
      path: `${prefix}${path}`,
      query: query ?? {},
      body: body ?? null,
    },
    response: { status: res.status, body: parsed },
  });
  return { status: res.status, body: parsed };
}
const get = (path: string, query?: Record<string, string>) =>
  http("GET", path, undefined, query);
const post = (path: string, body?: unknown) => http("POST", path, body ?? {});

const sockets: { key: string; ws: WebSocket; inbox: Json[] }[] = [];
async function subscribe(key: string, target: Json) {
  const ws = new WebSocket(`${url.replace("http", "ws")}/ws`);
  const entry = { key, ws, inbox: [] as Json[] };
  let pong = () => {};
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.type === "pong") pong();
    else entry.inbox.push(message);
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  ws.send(JSON.stringify({ type: "subscribe", target }));
  await new Promise<void>((resolve) => {
    pong = resolve;
    ws.send(JSON.stringify({ type: "ping" }));
  });
  sockets.push(entry);
}
function flushSockets() {
  for (const entry of sockets) {
    for (const message of entry.inbox.splice(0)) {
      record({ kind: "ws", subscription: entry.key, message });
    }
  }
}

const threads = new Map<string, string>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const row = (id: string) =>
  ctx.db.get<Json>("SELECT * FROM threads WHERE id = ?", id);
async function until(what: string, check: () => unknown, ms = 20_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await sleep(25);
  }
}
const completedTurns = (id: string): number =>
  ctx.db.get<Json>(
    "SELECT count(*) AS n FROM events WHERE thread_id = ? AND type = 'turn/completed'",
    id,
  ).n;
const seen = new Map<string, number>();
async function waitIdle(id: string, statuses = ["idle", "error"]) {
  const before = seen.get(id) ?? 0;
  await until(`thread ${id} settles`, async () => {
    const r = row(id);
    return (
      r &&
      r.activeTurnId == null &&
      statuses.includes(r.status) &&
      completedTurns(id) > before
    );
  });
  seen.set(id, completedTurns(id));
  await ctx.threads.settled();
  await sleep(50);
  await ctx.threads.settled();
  const r = row(id);
  record({
    kind: "wait",
    waitFor: "thread-settled",
    threadId: id,
    observed: { status: r.status, activeTurnId: r.activeTurnId ?? null },
  });
}
async function waitActive(id: string) {
  await until(`thread ${id} active`, () => row(id)?.activeTurnId);
  record({ kind: "wait", waitFor: "turn-active", threadId: id });
}
async function waitInteraction(id: string): Promise<Json> {
  const found = await until(`interaction on ${id}`, async () => {
    const res = await fetch(`${url}/api/v1/threads/${id}/interactions`);
    const list = (await res.json()) as Json[];
    return list.length > 0 ? list : undefined;
  });
  record({ kind: "wait", waitFor: "pending-interaction", threadId: id });
  return (found as Json[])[0];
}
const text = (value: string) => [{ type: "text", text: value, mentions: [] }];
async function createThread(name: string, body: Json, wait = true) {
  const res = await post("/threads", {
    origin: "app",
    providerId: "echo",
    startedOnBehalfOf: null,
    ...body,
  });
  const id = res.body?.id as string;
  if (!id) throw new Error(`create ${name} failed: ${JSON.stringify(res)}`);
  threads.set(name, id);
  await subscribe(`thread-detail:${name}`, {
    kind: "thread-detail",
    threadId: id,
  });
  if (wait) await waitIdle(id);
  return id;
}
const personal = (prompt: string) => ({
  projectId: "proj_personal",
  input: text(prompt),
  environment: { type: "host", workspace: { type: "personal" } },
});
const send = (id: string, prompt: string, mode = "auto") =>
  post(`/threads/${id}/send`, { input: text(prompt), mode });

let projectId = "";
const scenarios: [string, () => Promise<void>][] = [
  [
    "system-and-settings",
    async () => {
      await http("GET", "/health", undefined, undefined, "");
      const cfg = (await get("/system/config")).body;
      await get("/system/providers");
      await get("/system/providers/catalog");
      await get("/system/execution-options", { providerId: "echo" });
      await get("/system/environment-providers");
      await get("/sidebar-bootstrap");
      const general = cfg.generalSettings;
      await http("PUT", "/settings/general", {
        ...general,
        streamerMode: true,
      });
      await http("PUT", "/settings/general", { ...general, streamerMode: "x" });
      await http("PUT", "/settings/appearance", cfg.appearance);
      await http("PUT", "/settings/appearance", { mode: "dark" });
      await http("PUT", "/settings/keyboard", []);
      await http("PUT", "/settings/keyboard", {});
      await get("/system/config");
      await get("/preferences/ui");
      const pref = "/preferences/ui/sidebar.headerProvider";
      await http("PUT", pref, { expectedRevision: 0, value: "parity" });
      await http("PUT", pref, { expectedRevision: 0, value: "conflict" });
      await http("PUT", "/preferences/ui/sidebar.width", {
        expectedRevision: 0,
        value: 400,
      });
      await http("DELETE", pref);
      await get("/preferences/ui");
      await get("/hosts");
      await get(`/hosts/${HOST_ID}`);
      await get("/settings/machine-environment");
    },
  ],
  [
    "projects",
    async () => {
      const source = { type: "local_path", hostId: HOST_ID, path: repo };
      const created = await post("/projects", { name: "parity", source });
      projectId = created.body.id;
      await get("/projects");
      await get(`/projects/${projectId}`);
      await http("PATCH", `/projects/${projectId}`, { name: "parity-renamed" });
      const second = join(temp, "second");
      mkdirSync(second);
      const added = await post(`/projects/${projectId}/sources`, {
        type: "local_path",
        hostId: HOST_ID,
        path: second,
      });
      const sourceId = created.body.sources?.[0]?.id;
      if (sourceId) {
        await http("PATCH", `/projects/${projectId}/sources/${sourceId}`, {
          name: "second",
        });
        await http("DELETE", `/projects/${projectId}/sources/src_none`);
      }
      await get(`/projects/${projectId}/default-execution-options`);
      await get(`/projects/${projectId}/branches`, { hostId: HOST_ID });
      await get(`/projects/${projectId}/paths`, {
        hostId: HOST_ID,
        query: "a",
        includeFiles: "true",
        includeDirectories: "true",
      });
      const doomed = await post("/projects", {
        name: "doomed",
        source: { type: "local_path", hostId: HOST_ID, path: second },
      });
      await http("DELETE", `/projects/${doomed.body.id}`);
      await get("/projects");
    },
  ],
  [
    "thread-basics",
    async () => {
      await subscribe("thread-list", { kind: "thread-list" });
      const id = await createThread("basic", personal("hello pineapple world"));
      await get(`/threads/${id}`);
      await get(`/threads/${id}`, { include: "environment,host" });
      await get("/threads");
      await get(`/threads/${id}/events`);
      await get(`/threads/${id}/output`);
      await send(id, "second message pineapple");
      await waitIdle(id);
      await get(`/threads/${id}/prompt-history`);
      await http("PATCH", `/threads/${id}`, { title: "Renamed basic" });
      await post(`/threads/${id}/pin`);
      await post(`/threads/${id}/unpin`);
      await post(`/threads/${id}/read`);
      await post(`/threads/${id}/unread`);
      const section = await post("/thread-sections", { name: "Parity" });
      const sectionId = section.body?.section?.id ?? section.body?.id;
      await get("/thread-sections");
      await http("PATCH", `/threads/${id}`, { sectionId });
      await http("PATCH", "/thread-sections", { id: sectionId, name: "P2" });
      await http("DELETE", "/thread-sections", { id: sectionId });
      await get(`/threads/${id}`);
      const tabs = [{ id: "tab-1", kind: "new-tab" }];
      await http("PUT", `/threads/${id}/tabs`, { expectedRevision: 0, tabs });
      await http("PUT", `/threads/${id}/tabs`, { expectedRevision: 0, tabs });
      await get(`/threads/${id}/tabs`);
      flushSockets();
    },
  ],
  [
    "managed-worktree",
    async () => {
      const id = await createThread("worktree", {
        projectId,
        input: text("cmd:ls work in the worktree"),
        environment: { type: "project-default" },
      });
      const thread = await get(`/threads/${id}`, { include: "environment" });
      const envId = thread.body?.environmentId ?? thread.body?.environment?.id;
      await get("/environments");
      await get(`/environments/${envId}`);
      await get(`/environments/${envId}/status`);
      const path = thread.body?.environment?.path ?? repo;
      await post("/files/write", {
        hostId: HOST_ID,
        path: join(path, "notes.txt"),
        content: "parity notes\n",
      });
      await post("/files/read", {
        hostId: HOST_ID,
        path: join(path, "notes.txt"),
      });
      await post("/files/list", { hostId: HOST_ID, path });
      await get(`/environments/${envId}/diff/files`, { target: "uncommitted" });
      await get(`/environments/${envId}/diff/file`, {
        target: "uncommitted",
        path: "notes.txt",
      });
      await get(`/environments/${envId}/diff/branches`);
      await get(`/environments/${envId}/files/notes.txt`);
      await post(`/environments/${envId}/actions`, { action: "commit" });
      await get(`/environments/${envId}/status`);
      await get(`/environments/${envId}/diff/files`, { target: "all" });
      flushSockets();
    },
  ],
  [
    "tools-and-items",
    async () => {
      const id = await createThread(
        "tools",
        personal(
          "think:pondering cmd:echo_hi edit:src/a.ts tool:search subagent:helper all tools",
        ),
      );
      await send(id, "usage:12345 counting tokens");
      await waitIdle(id);
      await send(id, "fail_turn:boom this fails");
      await waitIdle(id);
      await get(`/threads/${id}`);
      await send(id, "crash now");
      await waitIdle(id);
      await get(`/threads/${id}`);
      await send(id, "resume after crash");
      await waitIdle(id);
      await get(`/threads/${id}/output`);
      flushSockets();
    },
  ],
  [
    "interactions",
    async () => {
      const allow = await createThread(
        "approve-allow",
        personal("approve please"),
        false,
      );
      let pending = await waitInteraction(allow);
      await get(`/threads/${allow}/interactions`);
      await get(`/threads/${allow}/interactions/${pending.id}`);
      await post(`/threads/${allow}/interactions/${pending.id}/resolve`, {
        decision: "allow_once",
        grantedPermissions: null,
      });
      await waitIdle(allow);
      const deny = await createThread(
        "approve-deny",
        personal("approve please"),
        false,
      );
      pending = await waitInteraction(deny);
      await post(`/threads/${deny}/interactions/${pending.id}/resolve`, {
        decision: "deny",
      });
      await waitIdle(deny);
      const ask = await createThread(
        "ask-user",
        personal("ask_user now"),
        false,
      );
      pending = await waitInteraction(ask);
      const qid = pending.payload?.questions?.[0]?.id ?? "q0";
      await post(`/threads/${ask}/interactions/${pending.id}/resolve`, {
        kind: "user_answer",
        answers: { [qid]: { selected: ["staging"] } },
      });
      await waitIdle(ask);
      const input = JSON.stringify({
        questions: [
          {
            question: "Pick_one?",
            header: "Pick",
            options: [
              { label: "Alpha", description: "first" },
              { label: "Beta", description: "second" },
            ],
          },
        ],
      });
      const plugin = await createThread(
        "plugin-question",
        personal(`call_tool:AskUserQuestion tool_input:${input}`),
        false,
      );
      pending = await waitInteraction(plugin);
      await get(`/threads/${plugin}/interactions`);
      await post(`/threads/${plugin}/interactions/${pending.id}/respond`, {
        value: { answers: { q0: { selected: ["Alpha"] } } },
      });
      await waitIdle(plugin);
      flushSockets();
    },
  ],
  [
    "steering-and-queueing",
    async () => {
      const id = await createThread(
        "steer",
        personal("hold_turn first"),
        false,
      );
      await waitActive(id);
      await send(id, "steered release_turn", "steer");
      await waitIdle(id);
      await send(id, "hold_turn again");
      await waitActive(id);
      const queued = await send(id, "queued one", "queue-if-active");
      const queuedId = queued.body?.queuedMessage?.id;
      await send(id, "queued two", "queue-if-active");
      const list = await get(`/threads/${id}/queued-messages`);
      const second = list.body?.[1] ?? list.body?.messages?.[1];
      await http("PATCH", `/threads/${id}/queued-messages/${queuedId}`, {
        expectedUpdatedAt: queued.body?.queuedMessage?.updatedAt ?? 0,
        input: text("queued one edited release_turn"),
      });
      if (second) {
        await http("DELETE", `/threads/${id}/queued-messages/${second.id}`);
      }
      await post(`/threads/${id}/queued-messages`, {
        input: text("queued three"),
      });
      await get(`/threads/${id}/queued-messages`);
      await post(`/threads/${id}/queued-messages/${queuedId}/send`, {
        mode: "steer",
      });
      await waitIdle(id);
      await get(`/threads/${id}/queued-messages`);
      await send(id, "hold_turn third");
      await waitActive(id);
      await send(id, "steer if active release_turn", "steer-if-active");
      await waitIdle(id);
      await send(id, "hold_turn to stop");
      await waitActive(id);
      await post(`/threads/${id}/stop`);
      await waitIdle(id);
      await send(id, "after stop");
      await waitIdle(id);
      await get(`/threads/${id}/queued-messages`);
      flushSockets();
    },
  ],
  [
    "parent-and-child",
    async () => {
      const parent = await createThread("parent", personal("parent thread"));
      const child = await createThread("child", {
        ...personal("child work pineapple"),
        parentThreadId: parent,
      });
      await waitIdle(parent);
      await get(`/threads/${child}`);
      await get(`/threads/${parent}/child-summary`);
      await get(`/threads/${parent}/events`);
      flushSockets();
    },
  ],
  [
    "lifecycle",
    async () => {
      const running = await createThread(
        "archive-running",
        personal("hold_turn"),
        false,
      );
      await waitActive(running);
      await post(`/threads/${running}/archive-all`);
      await get(`/threads/${running}`);
      await post(`/threads/${running}/unarchive`);
      await get(`/threads/${running}`);
      await post(`/threads/${running}/stop`);
      await waitIdle(running);
      await get(`/threads/${running}`);
      const gone = await createThread(
        "archive-delete",
        personal("short lived"),
      );
      await post(`/threads/${gone}/archive-all`);
      await http("DELETE", `/threads/${gone}`);
      await http("DELETE", `/threads/${gone}`, { childThreadsConfirmed: true });
      await get(`/threads/${gone}`);
      const parent = await createThread(
        "delete-parent",
        personal("parent to delete"),
      );
      const child = await createThread("delete-child", {
        ...personal("child to delete"),
        parentThreadId: parent,
      });
      await waitIdle(parent);
      await http("DELETE", `/threads/${parent}`, {
        childThreadsConfirmed: false,
      });
      await get(`/threads/${parent}/child-summary`);
      await http("DELETE", `/threads/${parent}`, {
        childThreadsConfirmed: true,
      });
      await get(`/threads/${child}`);
      await get("/threads");
      threads.delete("archive-delete");
      threads.delete("delete-parent");
      threads.delete("delete-child");
      flushSockets();
    },
  ],
  [
    "search",
    async () => {
      await get("/threads/search", { query: "pineapple" });
      await get("/threads/search", { q: "pineapple" });
    },
  ],
  [
    "errors",
    async () => {
      const id = threads.get("basic")!;
      await post("/threads", { nonsense: true });
      await http("POST", "/threads", "{not json");
      await get("/threads/thr_doesnotexist");
      await post("/threads/thr_doesnotexist/send", {
        input: text("x"),
        mode: "auto",
      });
      await post(`/threads/${id}/send`, { input: [], mode: "auto" });
      await get("/projects/proj_doesnotexist");
      await get("/environments/env_doesnotexist");
      await http("PATCH", `/threads/${id}`, {});
      await get(`/threads/${id}/timeline`, { segmentLimit: "abc" });
      const archived = await createThread("archived-send", personal("bye"));
      await post(`/threads/${archived}/archive-all`);
      await send(archived, "send to archived");
      await post(`/threads/${archived}/unarchive`);
      await get("/no/such/route");
      await http("DELETE", `/projects/${projectId}`);
      flushSockets();
    },
  ],
];

const turnSummaryRow = (rows: Json[]): Json =>
  rows.find(
    (r) =>
      typeof r?.turnId === "string" &&
      typeof r?.sourceSeqStart === "number" &&
      typeof r?.sourceSeqEnd === "number" &&
      (r.kind === "turn" || /summary/i.test(String(r.kind))),
  );
async function threadFixture(id: string): Promise<Json> {
  const fetchJson = async (
    path: string,
    query: Record<string, string> = {},
  ) => {
    clock += 1000;
    const target = new URL(`${url}/api/v1${path}`);
    for (const [k, v] of Object.entries(query)) target.searchParams.set(k, v);
    const res = await fetch(target);
    return { query, status: res.status, body: await res.json() };
  };
  const base = `/threads/${id}/timeline`;
  const timeline: Json[] = [];
  const first = await fetchJson(base);
  timeline.push(first);
  timeline.push(await fetchJson(base, { includeNestedRows: "true" }));
  timeline.push(await fetchJson(base, { summaryOnly: "true" }));
  const page = await fetchJson(base, { segmentLimit: "2" });
  timeline.push(page);
  const anchor = page.body?.rows?.[0];
  if (anchor && typeof anchor.sourceSeqStart === "number") {
    timeline.push(
      await fetchJson(base, {
        segmentLimit: "2",
        beforeAnchorSeq: String(anchor.sourceSeqStart),
        beforeAnchorId: String(anchor.id),
      }),
    );
  }
  timeline.push(await fetchJson(base, { afterSequence: "3" }));
  let turnSummaryDetails: Json = null;
  const summary = turnSummaryRow(first.body?.rows ?? []);
  if (summary) {
    turnSummaryDetails = await fetchJson(`${base}/turn-summary-details`, {
      turnId: summary.turnId,
      sourceSeqStart: String(summary.sourceSeqStart),
      sourceSeqEnd: String(summary.sourceSeqEnd),
    });
  }
  const rows = listEvents(ctx.db, { threadId: id });
  return {
    thread: ctx.db.get("SELECT * FROM threads WHERE id = ?", id),
    events: decodeEvents(ctx.db, rows),
    timeline,
    turnSummaryDetails,
  };
}

function sortKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys(value[k])]),
    );
  }
  return value;
}
const writeJson = (path: string, value: Json) =>
  writeFileSync(
    path,
    `${JSON.stringify(sortKeys(sanitize(value)), null, 1)}\n`,
  );

let exitCode = 0;
const fixtures = new Map<string, Json>();
try {
  const only = process.env.PARITY_SCENARIOS?.split(",");
  for (const [name, run] of scenarios) {
    if (only && !only.includes(name)) continue;
    scenario = name;
    stepNo = 0;
    try {
      await run();
    } catch (error) {
      exitCode = 1;
      console.error(`scenario ${name} failed:`, error);
      record({ kind: "error", message: String(error) });
    }
    flushSockets();
    for (const [threadName, id] of threads) {
      if (!fixtures.has(threadName)) {
        fixtures.set(threadName, await threadFixture(id));
      }
    }
  }
  rmSync(join(outDir, "threads"), { recursive: true, force: true });
  mkdirSync(join(outDir, "threads"), { recursive: true });
  for (const [name, fixture] of fixtures) {
    writeJson(join(outDir, "threads", `${name}.json`), fixture);
  }
  writeJson(join(outDir, "conversation.json"), steps);
  console.log(`recorded ${steps.length} steps, ${fixtures.size} threads`);
} finally {
  for (const { ws } of sockets) ws.close();
  await server.close();
  await local.shutdown();
  rmSync(temp, { recursive: true, force: true });
}
process.exit(exitCode);
