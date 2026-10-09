import { OWNER_USER_ID } from "@bb/domain";
import { currentActor, type Actor } from "../auth/actor.js";
import type { ServerServices } from "../context.js";
import { getEnvironment } from "../db/environments.js";
import { findHost, listHosts, type HostRow } from "../db/hosts.js";
import type { Db } from "../db/index.js";
import { getThread } from "../db/threads.js";
import { getUser, type UserRow } from "../db/users.js";
import { ApiError } from "../http/errors.js";
import type { Principal, TrustedUser } from "../http/trust.js";

type HostAccess = Pick<HostRow, "ownerUserId" | "sharing">;

export const THREAD_ID_HEADER = "x-bb-thread-id";

export function machineNotShared(): ApiError {
  return new ApiError(
    403,
    "machine_not_shared",
    "This machine is private to its owner. Ask them to share it, or use " +
      "another machine.",
  );
}

export function ownerUser(db: Db): TrustedUser {
  const owner = db.get<TrustedUser>(
    `SELECT id, role, avatar_url FROM users
     WHERE role = 'owner' AND disabled_at IS NULL
     ORDER BY rowid LIMIT 1`,
  );
  return owner ?? { id: OWNER_USER_ID, role: "owner" };
}

export function canUseHost(host: HostAccess, actor: Actor | null): boolean {
  if (actor === null || host.sharing === "shared") return true;
  return host.ownerUserId === null || host.ownerUserId === actor.userId;
}

export function canManageHost(host: HostAccess, actor: Actor | null): boolean {
  if (actor === null || actor.role === "owner") return true;
  return host.ownerUserId === null || host.ownerUserId === actor.userId;
}

export function assertHostUsable(
  ctx: ServerServices,
  hostId: string,
  actor: Actor | null = currentActor(),
): void {
  if (actor === null) return;
  const host = findHost(ctx.db, "id", hostId);
  if (host === undefined) {
    throw new ApiError(404, "host_not_found", "Host not found");
  }
  if (!canUseHost(host, actor)) throw machineNotShared();
}

export function defaultHostId(
  ctx: ServerServices,
  actor: Actor | null = currentActor(),
): string {
  const { db, runners } = ctx;
  const local = ctx.server.hostId;
  const usable = listHosts(db, { includeCreating: false })
    .filter((host) => host.phase === "active" && canUseHost(host, actor))
    .map((host) => ({
      id: host.id,
      rank:
        (actor !== null && host.ownerUserId === actor.userId ? 4 : 0) +
        (runners.isConnected(host.id) ? 2 : 0) +
        (host.id === local ? 1 : 0),
    }))
    .sort((left, right) => right.rank - left.rank);
  return usable[0]?.id ?? local;
}

function enabled(user: UserRow | undefined): UserRow | undefined {
  return user === undefined || user.disabledAt !== null ? undefined : user;
}

function threadHostId(db: Db, environmentId: string | null) {
  if (environmentId === null) return null;
  return getEnvironment(db, environmentId)?.hostId ?? null;
}

function onBehalfOf(
  db: Db,
  threadId: string | undefined,
  hostId: string | null,
): UserRow | undefined {
  const thread = threadId === undefined ? undefined : getThread(db, threadId);
  if (thread === undefined || thread.deletedAt !== null) return undefined;
  const threadHost = threadHostId(db, thread.environmentId);
  if (threadHost === null || threadHost !== hostId) return undefined;
  const userId = thread.lastActorUserId ?? thread.createdByUserId;
  return userId === null ? undefined : enabled(getUser(db, userId));
}

export function agentActor(db: Db, threadId: string): Actor | null {
  const thread = getThread(db, threadId);
  const userId = thread?.lastActorUserId ?? thread?.createdByUserId ?? null;
  const user = userId === null ? undefined : enabled(getUser(db, userId));
  if (user === undefined) return null;
  return { userId: user.id, role: user.role, agentThreadId: threadId };
}

export function actorOf(
  ctx: ServerServices,
  principal: Principal,
  threadId: string | undefined,
): Actor | null {
  const { db } = ctx;
  if (principal.kind === "anonymous") return null;
  if (principal.kind === "user") {
    const { userId, role } = principal;
    const agent = principal.implicit
      ? onBehalfOf(db, threadId, ctx.server.hostId)
      : undefined;
    if (agent === undefined) return { userId, role, agentThreadId: null };
    const { id, role: agentRole } = agent;
    return { userId: id, role: agentRole, agentThreadId: threadId ?? null };
  }
  const machineId = principal.connectMachineId;
  const host =
    principal.hostId !== null
      ? findHost(db, "id", principal.hostId)
      : machineId === null
        ? undefined
        : findHost(db, "connect_machine_id", machineId);
  const ownerId = host?.ownerUserId ?? null;
  const user =
    onBehalfOf(db, threadId, host?.id ?? null) ??
    (ownerId === null ? undefined : enabled(getUser(db, ownerId))) ??
    ownerUser(db);
  const agentThreadId = threadId ?? null;
  return { userId: user.id, role: user.role, agentThreadId };
}
