import { audit, type PluginServerApi } from "@bb/plugin";
import { listAudit } from "@bb/server-kit/db/audit";

export default function auditLog(bb: PluginServerApi): void {
  const { db } = bb;
  bb.implement(audit.list, ({ user, thread, ...query }, { caller }) => {
    const userId = caller.role === "member" ? (caller.user ?? "") : user;
    return listAudit(db, { ...query, userId, threadId: thread });
  });
}
