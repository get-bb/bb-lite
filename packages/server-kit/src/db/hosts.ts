import type {
  Host,
  HostType,
  MachineSharing,
  PermissionMode,
} from "@bb/domain";
import { insertRow, updateRow, type Db, type RowValues } from "./index.js";

export interface HostRow {
  id: string;
  name: string;
  type: HostType;
  phase: "creating" | "active" | "removing" | "destroyed";
  statusMessage: string | null;
  maxPermissionMode: PermissionMode;
  launchKey: string | null;
  tokenHash: string | null;
  joinTokenHash: string | null;
  joinExpiresAt: number | null;
  connectMachineId: string | null;
  lastInstanceId: string | null;
  lastEventSeq: number;
  lastSeenAt: number | null;
  lastRejectedProtocolVersion: number | null;
  platform: string | null;
  threadStorageRoot: string | null;
  ownerUserId: string | null;
  sharing: MachineSharing;
  machineProviderId: string | null;
  resource: string | null;
  suspendedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

type HostLookup =
  | "id"
  | "launch_key"
  | "token_hash"
  | "join_token_hash"
  | "connect_machine_id";
type NewHost = Pick<HostRow, "id" | "name" | "phase"> &
  Partial<
    Pick<
      HostRow,
      | "statusMessage"
      | "launchKey"
      | "ownerUserId"
      | "machineProviderId"
      | "resource"
    >
  >;

export function findHost(
  db: Db,
  column: HostLookup,
  value: string,
): HostRow | undefined {
  const sql = `SELECT * FROM hosts WHERE ${column} = ? AND destroyed_at IS NULL`;
  return db.get<HostRow>(sql, value);
}

export function findHostName(db: Db, id: string): string | null {
  const sql = "SELECT name FROM hosts WHERE id = ?";
  return db.get<{ name: string }>(sql, id)?.name ?? null;
}

export function listHosts(
  db: Db,
  filter: { includeCreating: boolean; type?: HostType },
): HostRow[] {
  return db
    .all<HostRow>(
      `SELECT * FROM hosts WHERE destroyed_at IS NULL
       ORDER BY created_at, id`,
    )
    .filter((host) => filter.includeCreating || host.phase !== "creating")
    .filter((host) => filter.type === undefined || host.type === filter.type);
}

export function insertHost(db: Db, host: NewHost): void {
  const at = { createdAt: db.now(), updatedAt: db.now() };
  insertRow(db, "hosts", { ...host, ...at }, "ignore");
}

export function updateHost(db: Db, id: string, patch: RowValues): void {
  updateRow(db, "hosts", id, patch);
}

export function advanceHostEventCursor(
  db: Db,
  id: string,
  instanceId: string,
  seq: number,
): void {
  db.run(
    `UPDATE hosts SET last_event_seq = MAX(last_event_seq, ?)
     WHERE id = ? AND last_instance_id = ?`,
    seq,
    id,
    instanceId,
  );
}

export function destroyHost(db: Db, id: string): void {
  updateRow(db, "hosts", id, {
    phase: "destroyed",
    destroyedAt: db.now(),
    tokenHash: null,
    joinTokenHash: null,
    joinExpiresAt: null,
    launchKey: null,
  });
}

export function toHost(
  row: HostRow,
  status: { connected: boolean; local: boolean; usable: boolean },
): Host {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    status: status.connected ? "connected" : "disconnected",
    machineProviderId: status.local
      ? null
      : (row.machineProviderId ?? "manual"),
    lifecycle: {
      phase:
        row.phase === "active" && row.suspendedAt !== null
          ? "suspended"
          : row.phase,
      suspendedAt: row.suspendedAt,
      message: row.statusMessage,
      pendingLog: "",
      teardown: null,
    },
    maxPermissionMode: row.maxPermissionMode,
    ownerUserId: row.ownerUserId,
    sharing: row.sharing,
    usable: status.usable,
    lastSeenAt: row.lastSeenAt,
    lastRejectedProtocolVersion: row.lastRejectedProtocolVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
