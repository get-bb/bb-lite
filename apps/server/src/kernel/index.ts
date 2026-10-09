import { createKernel, type Kernel } from "@bb/plugin";
import type { Logger } from "@bb/server-kit/context";
import { recordAudit } from "@bb/server-kit/db/audit";
import type { Db } from "@bb/server-kit/db/index";
import type { Hub } from "@bb/server-kit/ws/hub";
import { currentCaller, enterCaller } from "@bb/server-kit/kernel/caller";

const KERNEL_SIGNAL = "kernel";

export function createServerKernel(options: {
  db: Db;
  hub: Hub;
  log: Logger;
  now: () => number;
}): Kernel {
  const { db, hub, log, now } = options;
  return createKernel({
    currentCaller,
    enter: enterCaller,
    now,
    warn: (message, fields) => log.warn(message, fields),
    changed: (name, userId) =>
      void hub.pluginSignal(KERNEL_SIGNAL, "changed", { name }, userId),
    emitted: ({ name }, payload, userId) => {
      if (userId === undefined) return;
      hub.pluginSignal(KERNEL_SIGNAL, "emitted", { name, payload }, userId);
    },
    record(entry) {
      try {
        recordAudit(db, entry);
      } catch (error) {
        log.error("An audit record was not written", { err: error });
      }
    },
  });
}
