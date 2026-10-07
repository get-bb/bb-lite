import { AsyncLocalStorage } from "node:async_hooks";
import { OWNER_USER_ID, type UserRole } from "@bb/domain";

export interface Actor {
  userId: string;
  role: UserRole;
  agentThreadId: string | null;
}

const storage = new AsyncLocalStorage<Actor | null>();

export function runAs<T>(actor: Actor | null, work: () => T): T {
  return storage.run(actor, work);
}

export function asSystem<T>(work: () => T): T {
  return storage.run(null, work);
}

export function currentActor(): Actor | null {
  return storage.getStore() ?? null;
}

export function actorUserId(): string | null {
  return currentActor()?.userId ?? null;
}

export function viewerId(): string {
  return actorUserId() ?? OWNER_USER_ID;
}
