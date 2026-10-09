import { AsyncLocalStorage } from "node:async_hooks";
import type { Caller, Door } from "@bb/plugin";
import { currentActor } from "../auth/actor.js";

interface Origin {
  door: Door | null;
  via: readonly string[];
  machine: boolean;
}

const DECLARED_DOORS: readonly Door[] = ["app", "cli"];
const storage = new AsyncLocalStorage<Origin>();

export function declaredDoor(header: string | undefined): Door | null {
  return DECLARED_DOORS.find((door) => door === header) ?? null;
}

export function throughDoor<T>(
  door: Door | null,
  machine: boolean,
  work: () => T,
): T {
  return storage.run({ door, via: [], machine }, work);
}

export function currentCaller(): Caller {
  const actor = currentActor();
  const origin = storage.getStore();
  const via = origin?.via ?? [];
  if (actor === null) {
    return { user: null, role: "system", door: "system", thread: null, via };
  }
  const { userId: user, agentThreadId: thread } = actor;
  const role = origin?.machine === true ? "machine" : actor.role;
  const door = thread === null ? (origin?.door ?? "http") : "agent";
  return { user, role, door, thread, via };
}

export function enterCaller<T>(caller: Caller, work: () => T): T {
  const machine = storage.getStore()?.machine ?? false;
  return storage.run({ door: caller.door, via: caller.via, machine }, work);
}

export function asPlugin<T>(pluginId: string, work: () => T): T {
  const caller = currentCaller();
  if (caller.via.at(-1) === pluginId) return work();
  return enterCaller({ ...caller, via: [...caller.via, pluginId] }, work);
}
