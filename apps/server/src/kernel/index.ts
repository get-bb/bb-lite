import { createKernel, type Kernel } from "@bb/plugin";
import type { Logger } from "../context.js";
import { recordAudit } from "../db/audit.js";
import type { Db } from "../db/index.js";
import type { Hub } from "../ws/hub.js";
import { currentCaller, enterCaller } from "./caller.js";

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
    changed: (name) =>
      void hub.pluginSignal(KERNEL_SIGNAL, "changed", { name }),
    record(entry) {
      try {
        recordAudit(db, entry);
      } catch (error) {
        log.error("An audit record was not written", { err: error });
      }
    },
  });
}
