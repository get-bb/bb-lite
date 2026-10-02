import { hostname } from "node:os";
import type { Host } from "@bb/domain";
import { dataPaths } from "../config.js";
import type { ServerContext } from "../context.js";
import {
  findEnvironmentHostId,
  findHost,
  insertHost,
  toHost,
  updateHost,
  type HostRow,
} from "../db/hosts.js";
import { getAppSettings } from "../db/settings.js";
import { ApiError } from "../http/errors.js";
import type { Disposer } from "../server.js";

export function publicServerUrl(ctx: ServerContext): string | null {
  const { machineServerUrl } = getAppSettings(ctx.db);
  const url = ctx.plugins.publicUrl() ?? machineServerUrl;
  return url?.replace(/\/+$/u, "") ?? null;
}

export function requireHost(ctx: ServerContext, hostId: string): HostRow {
  const host = findHost(ctx.db, "id", hostId);
  if (host === undefined) {
    throw new ApiError(404, "host_not_found", "Host not found");
  }
  return host;
}

export function resolveLookupHostId(
  ctx: ServerContext,
  query: { hostId?: string; environmentId?: string },
): string {
  if (query.environmentId === undefined) {
    return requireHost(ctx, query.hostId ?? ctx.config.hostId).id;
  }
  const hostId = findEnvironmentHostId(ctx.db, query.environmentId);
  if (hostId === undefined) {
    throw new ApiError(404, "environment_not_found", "Environment not found");
  }
  return requireHost(ctx, hostId).id;
}

export function hostResponse(ctx: ServerContext, row: HostRow): Host {
  return toHost(row, {
    connected: ctx.runners.isConnected(row.id),
    local: row.id === ctx.config.hostId,
  });
}

export function ensureLocalHost(ctx: ServerContext): Disposer {
  const { db, runners } = ctx;
  const { hostId: id, dataDir } = ctx.config;
  const { platform } = process;
  const threadStorageRoot = dataPaths(dataDir).threadStorage;
  insertHost(db, { id, name: hostname(), phase: "active" });
  updateHost(db, id, { platform, threadStorageRoot, lastSeenAt: db.now() });
  const offConnected = runners.onConnected((hostId) => {
    const enrolling = findHost(db, "id", hostId)?.phase === "creating";
    updateHost(db, hostId, {
      lastSeenAt: db.now(),
      ...(enrolling ? { phase: "active", statusMessage: null } : {}),
    });
  });
  const offDisconnected = runners.onDisconnected((hostId) => {
    updateHost(db, hostId, { lastSeenAt: db.now() });
  });
  return () => {
    offConnected();
    offDisconnected();
  };
}
