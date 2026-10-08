import { audit, type PluginServerApi } from "@bb/plugin";
import { listAudit } from "@bb/server-kit/db/audit";
import { coreOf } from "@bb/server-kit/host";

export default function auditLog(bb: PluginServerApi): void {
  const { db } = coreOf(bb).ctx;
  bb.implement(audit.list, ({ user, thread, ...query }, { caller }) => {
    const userId = caller.role === "member" ? (caller.user ?? "") : user;
    return listAudit(db, { ...query, userId, threadId: thread });
  });
}
