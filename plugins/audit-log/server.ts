import { audit, type PluginServerApi } from "@bb/plugin";
import { listAudit, pruneAudit } from "@bb/server-kit/db/audit";

const DAY_MS = 24 * 60 * 60 * 1000;

export default function auditLog(bb: PluginServerApi): void {
  const { db } = bb;
  const settings = bb.settings.define({
    retentionDays: {
      type: "number",
      label: "Days to keep",
      description:
        "Audit records older than this are removed each night. 0 keeps them forever.",
      default: 90,
      min: 0,
      integer: true,
    },
  });
  const prune = async () => {
    const { retentionDays } = await settings.get();
    if (retentionDays <= 0) return;
    const removed = pruneAudit(db, bb.now() - retentionDays * DAY_MS);
    if (removed > 0) bb.log.info("Removed old audit records", { removed });
  };
  bb.implement(audit.list, ({ user, thread, ...query }, { caller }) => {
    const privileged = caller.role === "owner" || caller.role === "system";
    const userId = privileged ? user : (caller.user ?? "");
    return listAudit(db, { ...query, userId, threadId: thread });
  });
  bb.background.schedule("prune", "17 3 * * *", prune);
  bb.onStart(() => void prune());
}
