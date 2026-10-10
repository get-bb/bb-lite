import { hostname, userInfo } from "node:os";
import { OWNER_USER_ID, type Host } from "@bb/domain";
import { server } from "@bb/plugin";
import { currentActor } from "../auth/actor.js";
import { dataPaths } from "../config.js";
import type { Disposer, ServerServices } from "../context.js";
import { getEnvironment } from "../db/environments.js";
import * as hosts from "../db/hosts.js";
import { getAppSettings } from "../db/settings.js";
import { ApiError } from "../http/errors.js";
import { canUseHost, defaultHostId } from "./access.js";

export function publicServerUrl(ctx: ServerServices): string | null {
  const { machineServerUrl } = getAppSettings(ctx.db);
  const url = ctx.pick(server.publicUrl)?.() ?? machineServerUrl;
  return url?.replace(/\/+$/u, "") ?? null;
}

export function requireHost(
  ctx: ServerServices,
  hostId: string,
): hosts.HostRow {
  const host = hosts.findHost(ctx.db, "id", hostId);
  if (host === undefined) {
    throw new ApiError(404, "host_not_found", "Host not found");
  }
  return host;
}

export function resolveLookupHostId(
  ctx: ServerServices,
  query: { hostId?: string; environmentId?: string },
): string {
  if (query.environmentId === undefined) {
    return requireHost(ctx, query.hostId ?? defaultHostId(ctx)).id;
  }
  const environment = getEnvironment(ctx.db, query.environmentId);
  if (environment === undefined) {
    throw new ApiError(404, "environment_not_found", "Environment not found");
  }
  return requireHost(ctx, environment.hostId).id;
}

export function hostResponse(ctx: ServerServices, row: hosts.HostRow): Host {
  return hosts.toHost(row, {
    connected: ctx.runners.isConnected(row.id),
    local: row.id === ctx.server.hostId,
    usable: canUseHost(row, currentActor()),
  });
}

function nameOwnerAfterOsUser(db: ServerServices["db"]) {
  let username = "";
  try {
    ({ username } = userInfo());
  } catch {
    return;
  }
  if (username === "") return;
  db.run(
    "UPDATE users SET name = ? WHERE id = ? AND name = 'Owner'",
    username,
    OWNER_USER_ID,
  );
}

export function ensureLocalHost(ctx: ServerServices): Disposer {
  const { db, runners } = ctx;
  const { hostId: id, dataDir } = ctx.server;
  const { platform } = process;
  const threadStorageRoot = dataPaths(dataDir).threadStorage;
  const ownerUserId = OWNER_USER_ID;
  hosts.insertHost(db, { id, name: hostname(), phase: "active", ownerUserId });
  hosts.updateHost(db, id, {
    platform,
    threadStorageRoot,
    lastSeenAt: db.now(),
  });
  nameOwnerAfterOsUser(db);
  const offConnected = runners.onConnected((hostId) => {
    const enrolling = hosts.findHost(db, "id", hostId)?.phase === "creating";
    hosts.updateHost(db, hostId, {
      lastSeenAt: db.now(),
      ...(enrolling ? { phase: "active", statusMessage: null } : {}),
    });
  });
  const offDisconnected = runners.onDisconnected((hostId) => {
    hosts.updateHost(db, hostId, { lastSeenAt: db.now() });
  });
  return () => {
    offConnected();
    offDisconnected();
  };
}
