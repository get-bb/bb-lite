import {
  pendingInteractionSchema,
  type PendingInteraction,
  type PendingInteractionStatus,
} from "@bb/domain";
import { encodeJson, newId, type Db } from "./index.js";

export interface PendingInteractionRow {
  id: string;
  threadId: string;
  originKind: "provider" | "plugin";
  turnId: string | null;
  providerId: string | null;
  providerThreadId: string | null;
  providerRequestId: string | null;
  pluginId: string | null;
  rendererId: string | null;
  status: PendingInteractionStatus;
  statusReason: string | null;
  payload: string;
  resolution: string | null;
  createdAt: number;
  expiresAt: number | null;
  resolvedAt: number | null;
}

type Origin =
  | "turnId"
  | "providerId"
  | "providerThreadId"
  | "providerRequestId";
export type NewPendingInteraction = Pick<
  PendingInteractionRow,
  "threadId" | "originKind"
> &
  Partial<Pick<PendingInteractionRow, Origin | "pluginId" | "rendererId">> & {
    payload: unknown;
  };

export interface InteractionSettlement {
  status: PendingInteractionStatus;
  statusReason?: string;
  resolution?: unknown;
}

const ACTIVE = "status IN ('pending', 'resolving')";
const UNSCOPED_TURN_ID = "none";

export function getPendingInteraction(db: Db, id: string) {
  return db.get<PendingInteractionRow>(
    "SELECT * FROM pending_interactions WHERE id = ?",
    id,
  );
}

export function findProviderInteraction(
  db: Db,
  threadId: string,
  providerRequestId: string,
) {
  return db.get<PendingInteractionRow>(
    `SELECT * FROM pending_interactions
     WHERE thread_id = ? AND provider_request_id = ?`,
    threadId,
    providerRequestId,
  );
}

export function listActiveInteractions(db: Db, threadId: string) {
  return db.all<PendingInteractionRow>(
    `SELECT * FROM pending_interactions
     WHERE thread_id = ? AND ${ACTIVE} ORDER BY created_at`,
    threadId,
  );
}

export function listActivePluginInteractions(db: Db) {
  return db.all<PendingInteractionRow>(
    `SELECT * FROM pending_interactions
     WHERE origin_kind = 'plugin' AND ${ACTIVE}`,
  );
}

export function hasTurnBoundInteraction(db: Db, threadId: string): boolean {
  const rows = listActiveInteractions(db, threadId);
  return rows.some((row) => row.originKind === "provider");
}

export function insertPendingInteraction(
  db: Db,
  input: NewPendingInteraction,
): PendingInteractionRow {
  const id = newId("pint");
  const now = db.now();
  db.run(
    `INSERT INTO pending_interactions
       (id, thread_id, origin_kind, turn_id, provider_id, provider_thread_id,
        provider_request_id, plugin_id, renderer_id, status, payload,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    id,
    input.threadId,
    input.originKind,
    input.turnId ?? null,
    input.providerId ?? null,
    input.providerThreadId ?? null,
    input.providerRequestId ?? null,
    input.pluginId ?? null,
    input.rendererId ?? null,
    encodeJson(input.payload),
    now,
    now,
  );
  const row = getPendingInteraction(db, id);
  if (row === undefined) throw new Error("Interaction insert was lost");
  return row;
}

export function settleInteraction(
  db: Db,
  id: string,
  from: readonly PendingInteractionStatus[],
  next: InteractionSettlement,
): PendingInteractionRow | undefined {
  const current = getPendingInteraction(db, id);
  if (current === undefined || !from.includes(current.status)) return undefined;
  const now = db.now();
  const resolution =
    next.resolution === undefined
      ? current.resolution
      : encodeJson(next.resolution);
  db.run(
    `UPDATE pending_interactions
     SET status = ?, status_reason = ?, resolution = ?, resolved_at = ?,
         updated_at = ?
     WHERE id = ?`,
    next.status,
    next.statusReason ?? null,
    resolution,
    next.status === "resolving" ? null : now,
    now,
    id,
  );
  return getPendingInteraction(db, id);
}

export function toPendingInteraction(
  row: PendingInteractionRow,
): PendingInteraction {
  const { providerId, providerThreadId, providerRequestId } = row;
  const provider = { providerId, providerThreadId, providerRequestId };
  const { pluginId, rendererId, resolution } = row;
  const fromProvider = row.originKind === "provider";
  return pendingInteractionSchema.parse({
    ...row,
    ...(fromProvider
      ? { turnId: row.turnId ?? UNSCOPED_TURN_ID }
      : { providerId: undefined }),
    origin: fromProvider
      ? { kind: "provider", ...provider }
      : { kind: "plugin", pluginId, rendererId },
    payload: JSON.parse(row.payload),
    resolution: resolution === null ? null : JSON.parse(resolution),
  });
}
