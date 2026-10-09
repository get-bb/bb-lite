import { threads, type PluginServerApi } from "@bb/plugin";
import { drafts } from "./contract.js";

export default function draftsPlugin(bb: PluginServerApi): void {
  const { kv } = bb.storage;
  const key = (threadId: string) => `drafts:${threadId}`;
  const saved = async (threadId: string) =>
    (await kv.get<string[]>(key(threadId))) ?? [];
  const creating = new Map<string, Promise<unknown>>();

  bb.implement(drafts.create, async ({ threadId, text }) => {
    const input = [{ type: "text" as const, text, mentions: [] }];
    const made = bb
      .call(threads.createQueuedMessage, { threadId, input })
      .then(async ({ id }) => {
        await kv.set(key(threadId), [...(await saved(threadId)), id]);
        return { queuedMessageId: id };
      });
    creating.set(
      threadId,
      made.catch(() => null),
    );
    try {
      return await made;
    } finally {
      creating.delete(threadId);
    }
  });

  bb.on(threads.hold, async (asked, next) => {
    const { threadId, sendNow } = asked;
    await creating.get(threadId);
    const ids = await saved(threadId);
    if (sendNow || ids.length === 0) return next();
    const queued = await bb.call(threads.listQueuedMessages, { threadId });
    const kept = ids.filter((id) => queued.some((row) => row.id === id));
    if (kept.length !== ids.length) await kv.set(key(threadId), kept);
    const [lead] = queued;
    if (lead !== undefined && kept.includes(lead.id)) {
      return { pluginId: bb.pluginId, reason: "Draft" };
    }
    return next();
  });
}
