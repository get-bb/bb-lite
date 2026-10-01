import type { PromptInput } from "@bb/domain";
import type {
  RunnerEvent,
  RunnerThreadEvent,
  SubmitTurnArgs,
} from "@bb/runner";
import type { CreateThreadRequest } from "@bb/server-contract";
import type { ThreadRow } from "../src/db/threads.js";
import { createTestServer } from "./helpers.js";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
type Emitted = DistributiveOmit<RunnerEvent, "lane" | "seq">;
type TurnStatus = "completed" | "failed" | "interrupted";
type SpawnRequest = Omit<CreateThreadRequest, keyof typeof FIRST_MESSAGE>;

export const FIRST_MESSAGE = { startedOnBehalfOf: null, originKind: null };

export const PROVIDER_THREAD_ID = "prov-1";
const providerThreadId = PROVIDER_THREAD_ID;

export function text(value: string): PromptInput[] {
  return [{ type: "text", text: value, mentions: [] }];
}

function turn(turnId: string) {
  return { kind: "turn" as const, turnId };
}

export const events = {
  identity: (): RunnerThreadEvent => ({
    type: "thread/identity",
    scope: { kind: "thread" },
    providerThreadId,
  }),
  started: (turnId: string): RunnerThreadEvent => ({
    type: "turn/started",
    scope: turn(turnId),
    providerThreadId,
  }),
  completed: (turnId: string, status: TurnStatus = "completed") =>
    ({
      type: "turn/completed",
      scope: turn(turnId),
      providerThreadId,
      status,
    }) satisfies RunnerThreadEvent,
  message(turnId: string, id: string, reply: string): RunnerThreadEvent[] {
    const scope = turn(turnId);
    const item = { type: "agentMessage" as const, id };
    const delta = (part: string): RunnerThreadEvent => ({
      type: "item/agentMessage/delta",
      scope,
      providerThreadId,
      itemId: id,
      delta: part,
    });
    return [
      {
        type: "item/started",
        scope,
        providerThreadId,
        item: { ...item, text: "" },
      },
      ...reply.split(" ").map(delta),
      {
        type: "item/completed",
        scope,
        providerThreadId,
        item: { ...item, text: reply },
      },
    ];
  },
};

export async function createThreadServer() {
  const server = await createTestServer();
  const { ctx, runner, api } = server;
  const { db } = ctx;
  const hostId = ctx.config.hostId;
  db.run(
    "INSERT INTO hosts (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)",
    hostId,
    "local",
  );
  db.run(
    `INSERT INTO projects (id, name, created_at, updated_at)
     VALUES ('proj_1', 'Project', 1, 1)`,
  );
  db.run(
    `INSERT INTO project_sources
       (id, project_id, host_id, path, created_at, updated_at)
     VALUES ('src_1', 'proj_1', ?, '/repo', 1, 1)`,
    hostId,
  );
  let seq = 0;
  const submitted: SubmitTurnArgs[] = [];
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
    listProviders: async () => [{ providerId: "codex", installed: true }],
    snapshot: async () => ({ sessions: [] }),
  });
  const settle = (): Promise<void> => ctx.threads.settled();
  const emit = async (event: Emitted): Promise<void> => {
    seq += 1;
    runner.emit({ lane: "reliable", seq, ...event } as RunnerEvent);
    await new Promise((resolve) => setImmediate(resolve));
    await settle();
  };
  const ingest = (threadId: string, ...batch: RunnerThreadEvent[]) =>
    emit({ kind: "thread.events", threadId, events: batch });
  const thread = (threadId: string): ThreadRow => {
    const row = db.get<ThreadRow>(
      "SELECT * FROM threads WHERE id = ?",
      threadId,
    );
    if (row === undefined) throw new Error(`Thread ${threadId} is gone`);
    return row;
  };
  const eventTypes = (threadId: string): string[] =>
    db
      .all<{ type: string }>(
        "SELECT type FROM events WHERE thread_id = ? ORDER BY sequence",
        threadId,
      )
      .map((row) => row.type);
  const eventData = (threadId: string, type: string) =>
    db
      .all<{ data: string }>(
        `SELECT data FROM events WHERE thread_id = ? AND type = ?
         ORDER BY sequence`,
        threadId,
        type,
      )
      .map((row) => JSON.parse(row.data) as Record<string, unknown>);
  const queued = (threadId: string) =>
    db
      .all<{ id: string; waitingOn: string | null }>(
        `SELECT id, waiting_on FROM queued_thread_messages
         WHERE thread_id = ? ORDER BY sort_key`,
        threadId,
      )
      .map((row) => {
        const wait = JSON.parse(row.waitingOn ?? "null") as { kind: string };
        return wait?.kind ?? null;
      });
  const spawn = async (overrides: Partial<SpawnRequest> = {}) => {
    const response = await api.threads.$post({
      json: {
        ...FIRST_MESSAGE,
        projectId: "proj_1",
        origin: "app",
        input: text("Please refactor the scheduler module today"),
        model: "gpt-test",
        environment: {
          type: "provider",
          environmentProviderId: "project-checkout",
          inputs: null,
        },
        ...overrides,
      },
    });
    const created = await response.json();
    if (response.status !== 201) throw new Error(JSON.stringify(created));
    await settle();
    return created.id;
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
    emit,
    ingest,
    thread,
    eventTypes,
    eventData,
    queued,
    spawn,
    runTurn,
  };
}
