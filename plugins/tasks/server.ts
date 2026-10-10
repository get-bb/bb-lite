import type { PluginServerApi } from "@bb/plugin";
import { registerTasksOps } from "./api/ops.js";
import { registerAttachments } from "./attachments/index.js";
import { registerTasksCli } from "./cli/index.js";
import { createTasksStore } from "./db/store.js";
import { registerLifecycle } from "./delegate/index.js";
import { registerMentions } from "./mentions/index.js";

export default async function plugin(bb: PluginServerApi): Promise<void> {
  const ctx = { bb, store: createTasksStore(bb.storage.database()) };
  registerTasksOps(ctx);
  registerAttachments(ctx);
  registerTasksCli(ctx);
  registerMentions(ctx);
  await registerLifecycle(ctx);
}
