import type { PendingInteractionPayload, PromptInput } from "@bb/domain";
import type {
  RunnerEvent,
  RunnerThreadEvent,
  SubmitTurnArgs,
} from "@bb/runner";
import type { CreateThreadRequest } from "@bb/server-contract";
import { insertRow, type SqlValue } from "@bb/server-kit/db/index";
import { insertTerminal } from "@bb/server-kit/db/terminals";
import type { ThreadRow } from "@bb/server-kit/db/threads";
import type { ThreadEnvironment } from "@bb/server-kit/environments/types";
import { createTestServer, type Json, type TestSocket } from "./helpers.js";

type TurnStatus = "completed" | "failed" | "interrupted";
type Spawn = Partial<Omit<CreateThreadRequest, "startedOnBehalfOf">>;
export type ThreadServer = Awaited<ReturnType<typeof createThreadServer>>;

const providerThreadId = "prov-1";
const provider = { providerId: "codex" as const, providerThreadId };

export function text(value: string): PromptInput[] {
  return [{ type: "text", text: value, mentions: [] }];
}

function turn(turnId: string) {
  return { scope: { kind: "turn" as const, turnId }, providerThreadId };
}

export const events = {
  identity: (): RunnerThreadEvent => ({
    type: "thread/identity",
    scope: { kind: "thread" },
    providerThreadId,
  }),
  started: (turnId: string): RunnerThreadEvent => ({
    type: "turn/started",
    ...turn(turnId),
  }),
  completed: (turnId: string, status: TurnStatus = "completed") =>
    ({ type: "turn/completed", ...turn(turnId), status }) as const,
  message(turnId: string, id: string, reply: string): RunnerThreadEvent[] {
    const item = { type: "agentMessage" as const, id };
    const delta = (part: string): RunnerThreadEvent => ({
      type: "item/agentMessage/delta",
      ...turn(turnId),
      itemId: id,
      delta: part,
    });
    const scoped = turn(turnId);
    return [
      { type: "item/started", ...scoped, item: { ...item, text: "" } },
      ...reply.split(" ").map(delta),
      { type: "item/completed", ...scoped, item: { ...item, text: reply } },
    ];
  },
};

export async function createThreadServer() {
  const server = await createTestServer();
  const { ctx, runner, api } = server;
  const { db } = ctx;
  const hostId = ctx.config.hostId;
  const at = { createdAt: 1, updatedAt: 1 };
  const source = { id: "src_1", projectId: "proj_1", hostId, path: "/repo" };
  insertRow(db, "projects", { id: "proj_1", name: "P", ...at });
  insertRow(db, "project_sources", { ...source, ...at });
  let seq = 0;
  const submitted: SubmitTurnArgs[] = [];
  const plainDirectory = { defaultBranch: null, originDefaultBranch: null };
  Object.assign(runner.script, {
    submitTurn: async (args: SubmitTurnArgs) => {
      submitted.push(args);
      return { outcome: "started", providerThreadId };
    },
    interruptTurn: async () => ({ interrupted: true }),
    releaseSession: async () => {},
    renameSession: async () => {},
    resolveInteraction: async () => ({ delivered: true }),
    resolveToolCall: async () => ({ delivered: true }),
    deleteThreadStorage: async () => {},
    describe: async () => ({ instanceId: "inst-1", homeDir: "/home/me" }),
    snapshot: async () => ({ sessions: [] }),
    listProviders: async () => [{ providerId: "codex", installed: true }],
    inspectGitSource: async () => plainDirectory,
    inspectPath: async () => ({ exists: true, isGitRepo: false }),
    createWorktree: async ({ key }: { key: string }) => {
      const path = `/worktrees/${key}`;
      return { path, mergeBaseBranch: "main", worktreeInclude: null };
    },
    pathsExist: async () => ({ existence: {} }),
  });
  const settle = () => ctx.threads.settled();
  const rows = <Row = Json>(sql: string, ...params: SqlValue[]) =>
    db.all<Row>(sql, ...params);
  const emit = async (event: Json) => {
    seq += 1;
    runner.emit({ lane: "reliable", seq, ...event } as RunnerEvent);
    await new Promise((resolve) => setImmediate(resolve));
    await settle();
  };
  const ingest = (threadId: string, ...batch: RunnerThreadEvent[]) =>
    emit({ kind: "thread.events", threadId, events: batch });
  const thread = (threadId: string) =>
    rows<ThreadRow>("SELECT * FROM threads WHERE id = ?", threadId)[0];
  const eventData = (threadId: string, type: string) =>
    rows<{ data: string }>(
      `SELECT data FROM events WHERE thread_id = ? AND type LIKE ?
       ORDER BY sequence`,
      threadId,
      type,
    ).map((row) => JSON.parse(row.data) as Json);
  const eventTypes = (threadId: string) =>
    rows<{ type: string }>(
      "SELECT type FROM events WHERE thread_id = ? ORDER BY sequence",
      threadId,
    ).map((row) => row.type);
  const queued = (threadId: string) =>
    rows<{ kind: string | null }>(
      `SELECT json_extract(waiting_on, '$.kind') AS kind
       FROM queued_thread_messages WHERE thread_id = ? ORDER BY sort_key`,
      threadId,
    ).map((row) => row.kind);
  const http = async <Body = Json>(
    method: string,
    path: string,
    json?: unknown,
  ) => {
    const response =
      json === undefined
        ? await server.request(path, { method })
        : await server.send(path, json, method);
    await settle();
    return { status: response.status, body: (await response.json()) as Body };
  };
  const spawn = async (overrides: Spawn = {}, settles = true) => {
    const created = await api.threads.$post({
      json: {
        projectId: "proj_1",
        origin: "app",
        input: text("Please refactor the scheduler module today"),
        model: "gpt-test",
        environment: { type: "project-default" },
        startedOnBehalfOf: null,
        ...overrides,
      },
    });
    const { id } = await created.json();
    if (created.status !== 201) throw new Error("Thread was not created");
    if (settles) await settle();
    return id;
  };
  const send = async (
    id: string,
    mode: string,
    message: string,
    at?: number,
  ) => {
    const json = { input: text(message), mode, sendAt: at };
    const { status, body } = await http("POST", `/threads/${id}/send`, json);
    const details = body.details as { reason: string } | undefined;
    const row = body.queuedMessage as { waitingOn: Json } | undefined;
    const outcome = body.delivery ?? details?.reason ?? body.code;
    return [status, outcome, row?.waitingOn.kind].filter(Boolean);
  };
  const lastSubmit = (): unknown[] => {
    const { input, mode } = submitted[submitted.length - 1];
    const [part] = input;
    return [part.type === "text" ? part.text : part.type, mode.kind];
  };
  const interact = (
    threadId: string,
    requestId: string,
    payload: PendingInteractionPayload,
    turnId = "t1",
  ) => {
    const request = { threadId, turnId, requestId, ...provider, payload };
    return emit({ kind: "interaction.requested", ...request });
  };
  const callsTo = (method: string) =>
    runner.calls
      .filter((call) => call.method === method)
      .map((call) => call.args[0]);
  const openTerminal = (threadId: string) => {
    const owner = { threadId, environmentId: null, hostId, title: "sh" };
    const shape = { initialCwd: "/repo", cols: 80, rows: 24 };
    return { terminalId: insertTerminal(db, { ...owner, ...shape }).id };
  };
  const advance = async (ms: number) => {
    server.clock.now += ms;
    ctx.threads.sweep();
    await settle();
  };
  const reconnect = async () => {
    ctx.runners.connect(hostId, (sink) => {
      runner.emit = sink;
      return runner.api;
    });
    await settle();
  };
  const deferEnvironment = () => {
    let release = () => {};
    const { ensureForThread } = ctx.environments;
    ctx.environments.ensureForThread = (args) =>
      new Promise<ThreadEnvironment>((resolve, reject) => {
        release = () => void ensureForThread(args).then(resolve, reject);
      });
    return () => release();
  };
  const changes = async (client: TestSocket, kind?: string) => {
    const message = await client.next(
      (change) => kind === undefined || String(change.changes).includes(kind),
    );
    return [message.changes, message.metadata];
  };
  const runTurn = async (threadId: string, turnId: string, reply = "done") => {
    await ingest(threadId, events.identity(), events.started(turnId));
    const message = events.message(turnId, `${turnId}-i1`, reply);
    await ingest(threadId, ...message, events.completed(turnId));
  };
  return {
    ...server,
    hostId,
    submitted,
    settle,
    rows,
    emit,
    ingest,
    thread,
    eventData,
    eventTypes,
    queued,
    http,
    spawn,
    send,
    lastSubmit,
    interact,
    callsTo,
    openTerminal,
    advance,
    reconnect,
    deferEnvironment,
    changes,
    runTurn,
  };
}
