import type { Host, HostType, PermissionMode } from "@bb/domain";
import type { Db } from "./index.js";
import { updateRow, type RowPatch } from "./update-row.js";

export type HostPhase = "creating" | "active" | "removing" | "destroyed";

export interface HostRow {
  id: string;
  name: string;
  type: HostType;
  phase: HostPhase;
  statusMessage: string | null;
  maxPermissionMode: PermissionMode;
  launchKey: string | null;
  tokenHash: string | null;
  joinTokenHash: string | null;
  joinExpiresAt: number | null;
  connectMachineId: string | null;
  lastSeenAt: number | null;
  lastRejectedProtocolVersion: number | null;
  platform: string | null;
  threadStorageRoot: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface NewHost {
  id: string;
  name: string;
  phase: HostPhase;
  statusMessage?: string;
  launchKey?: string;
}

type HostLookup = "id" | "launch_key" | "token_hash" | "join_token_hash";

const HOST_COLUMNS = `id, name, type, phase, status_message,
  max_permission_mode, launch_key, token_hash, join_token_hash,
  join_expires_at, connect_machine_id, last_seen_at,
  last_rejected_protocol_version, platform, thread_storage_root, created_at,
  updated_at`;

export function findHost(
  db: Db,
  column: HostLookup,
  value: string,
): HostRow | undefined {
  return db.get<HostRow>(
    `SELECT ${HOST_COLUMNS} FROM hosts
     WHERE ${column} = ? AND destroyed_at IS NULL`,
    value,
  );
}

export function findEnvironmentHostId(
  db: Db,
  environmentId: string,
): string | undefined {
  const environment = db.get<{ hostId: string }>(
    "SELECT host_id FROM environments WHERE id = ?",
    environmentId,
  );
  return environment?.hostId;
}

export function listHosts(
  db: Db,
  filter: { includeCreating: boolean; type?: HostType },
): HostRow[] {
  return db
    .all<HostRow>(
      `SELECT ${HOST_COLUMNS} FROM hosts WHERE destroyed_at IS NULL
       ORDER BY created_at, id`,
    )
    .filter((host) => filter.includeCreating || host.phase !== "creating")
    .filter((host) => filter.type === undefined || host.type === filter.type);
}

export function insertHost(db: Db, host: NewHost): void {
  db.run(
    `INSERT INTO hosts
       (id, name, phase, status_message, launch_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    host.id,
    host.name,
    host.phase,
    host.statusMessage ?? null,
    host.launchKey ?? null,
    db.now(),
    db.now(),
  );
}

export function updateHost(db: Db, id: string, patch: RowPatch): void {
  updateRow(db, "hosts", id, patch);
}

export interface HostEventCursor {
  lastInstanceId: string | null;
  lastEventSeq: number;
}

export function findHostEventCursor(
  db: Db,
  id: string,
): HostEventCursor | undefined {
  return db.get<HostEventCursor>(
    `SELECT last_instance_id, last_event_seq FROM hosts
     WHERE id = ? AND destroyed_at IS NULL`,
    id,
  );
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
  status: { connected: boolean; local: boolean },
): Host {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    status: status.connected ? "connected" : "disconnected",
    machineProviderId: status.local ? null : "manual",
    lifecycle: {
      phase: row.phase,
      suspendedAt: null,
      message: row.statusMessage,
      pendingLog: "",
      teardown: null,
    },
    maxPermissionMode: row.maxPermissionMode,
    lastSeenAt: row.lastSeenAt,
    lastRejectedProtocolVersion: row.lastRejectedProtocolVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
