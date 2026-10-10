import { AsyncLocalStorage } from "node:async_hooks";
import type { Caller, Door } from "@bb/plugin";
import { currentActor } from "../auth/actor.js";

interface Origin {
  door: Door | null;
  via: readonly string[];
  machine: boolean;
  app?: string;
  thread?: string | null;
}

const PLUGIN_ID = /^[a-z0-9][a-z0-9-]*$/u;

export function declaredAppPlugin(header: string | undefined): string | null {
  return header !== undefined && PLUGIN_ID.test(header) ? header : null;
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
  app: string | null = null,
): T {
  const claimed = door === "app" && app !== null ? { app } : {};
  return storage.run({ door, via: [], machine, ...claimed }, work);
}

export function currentCaller(): Caller {
  const actor = currentActor();
  const origin = storage.getStore();
  const via = origin?.via ?? [];
  if (actor === null) {
    return { user: null, role: "system", door: "system", thread: null, via };
  }
  const { userId: user, agentThreadId } = actor;
  const role = origin?.machine === true ? "machine" : actor.role;
  const door = agentThreadId === null ? (origin?.door ?? "http") : "agent";
  const thread = agentThreadId ?? origin?.thread ?? null;
  const claimed = origin?.app === undefined ? {} : { app: origin.app };
  return { user, role, door, thread, via, ...claimed };
}

export function enterCaller<T>(caller: Caller, work: () => T): T {
  const machine = storage.getStore()?.machine ?? false;
  const { door, via, thread } = caller;
  const claimed = caller.app === undefined ? {} : { app: caller.app };
  return storage.run({ door, via, machine, thread, ...claimed }, work);
}

export function asPlugin<T>(pluginId: string, work: () => T): T {
  const caller = currentCaller();
  if (caller.via.at(-1) === pluginId) return work();
  return enterCaller({ ...caller, via: [...caller.via, pluginId] }, work);
}
