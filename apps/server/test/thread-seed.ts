import type { Db, SqlValue } from "@bb/server-kit/db/index";

export type SeedRow = Record<string, unknown>;

export interface SeedEvent {
  type: string;
  turnId?: string;
  data?: {
    item?: { id: string; type: string; [key: string]: unknown };
    itemId?: string;
    parentToolCallId?: string;
    providerThreadId?: string;
    [key: string]: unknown;
  };
}

export function insertRow(db: Db, table: string, values: SeedRow): void {
  const columns = db
    .all<{ name: string }>("SELECT name FROM pragma_table_info(?)", table)
    .map((column) => column.name)
    .filter((name) => values[name] !== undefined);
  const bound = columns.map((name) => [name, values[name] as SqlValue]);
  db.run(
    `INSERT OR REPLACE INTO ${table} (${columns.join(", ")})
     VALUES (${columns.map((name) => `@${name}`).join(", ")})`,
    Object.fromEntries(bound),
  );
}

export function seedWorkspace(db: Db, hostId: string): void {
  const at = { created_at: 1_000, updated_at: 1_000 };
  insertRow(db, "hosts", { id: hostId, name: "bee", ...at });
  insertRow(db, "projects", { id: "proj_demo", name: "demo", ...at });
  insertRow(db, "environments", {
    id: "env_demo",
    project_id: "proj_demo",
    host_id: hostId,
    path: "/work/demo",
    status: "ready",
    environment_provider_id: "project-checkout",
    ...at,
  });
}

export function seedThread(db: Db, id: string, overrides: SeedRow = {}): void {
  insertRow(db, "threads", {
    id,
    project_id: "proj_demo",
    environment_id: "env_demo",
    provider_id: "codex",
    title: `Thread ${id}`,
    status: "idle",
    latest_attention_at: 1_000,
    last_read_at: 2_000,
    created_at: 1_000,
    updated_at: 1_000,
    ...overrides,
  });
}

export function appendEvents(
  db: Db,
  threadId: string,
  events: readonly SeedEvent[],
): void {
  const last = db.get<{ sequence: number | null }>(
    "SELECT MAX(sequence) AS sequence FROM events WHERE thread_id = ?",
    threadId,
  );
  events.forEach((event, index) => {
    const sequence = (last?.sequence ?? 0) + index + 1;
    const { data = {}, turnId = null } = event;
    insertRow(db, "events", {
      id: `evt_${threadId}_${sequence}`,
      thread_id: threadId,
      scope_kind: turnId === null ? "thread" : "turn",
      turn_id: turnId,
      provider_thread_id: data.providerThreadId ?? null,
      sequence,
      type: event.type,
      item_id: data.item?.id ?? data.itemId ?? null,
      item_kind: data.item?.type ?? null,
      parent_tool_call_id:
        data.item?.parentToolCallId ?? data.parentToolCallId ?? null,
      data: JSON.stringify(data),
      created_at: 1_000 + sequence,
    });
  });
}

export function userRequest(requestId: string, text: string): SeedEvent {
  return {
    type: "client/turn/requested",
    data: {
      direction: "outbound",
      source: "tell",
      initiator: "user",
      request: { method: "turn/start", params: {} },
      requestId,
      senderThreadId: null,
      input: [{ type: "text", text, mentions: [] }],
      target: { kind: "new-turn" },
      execution: {
        model: "gpt-test",
        permissionMode: "auto",
        reasoningLevel: "low",
        serviceTier: "default",
        source: "client/turn/requested",
      },
    },
  };
}

export function agentTurn(
  turnId: string,
  requestId: string,
  reply: string,
  status: "completed" | "open" = "completed",
): SeedEvent[] {
  const turn = (type: string, data: SeedEvent["data"] = {}): SeedEvent => ({
    type,
    turnId,
    data: { providerThreadId: "provider-thread", ...data },
  });
  const message = { type: "agentMessage", id: `${turnId}-i1`, text: reply };
  const command = {
    type: "commandExecution",
    id: `${turnId}-i0`,
    command: "ls",
    cwd: "/work/demo",
    approvalStatus: null,
  };
  const output = { status: "completed", aggregatedOutput: "a.txt\n" };
  const open = [
    turn("turn/started"),
    turn("turn/input/accepted", { clientRequestId: requestId }),
    turn("item/started", { item: { ...command, status: "pending" } }),
    turn("item/completed", { item: { ...command, ...output, exitCode: 0 } }),
    turn("item/started", { item: { ...message, text: "" } }),
    turn("item/agentMessage/delta", { itemId: message.id, delta: reply }),
  ];
  if (status === "open") return open;
  const completed = turn("turn/completed", { status: "completed" });
  return [...open, turn("item/completed", { item: message }), completed];
}
