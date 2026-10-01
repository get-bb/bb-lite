import { ThreadTitleMentions } from "@/components/thread/ThreadTitleMentions";
import { useSidebarThreadEntry } from "@/lib/plugin-sidebar-hooks";
import { getThreadDisplayTitle } from "@/lib/thread-title";

export function PluginThreadTitle({ threadId }: { threadId: string }) {
  const entry = useSidebarThreadEntry(threadId);
  if (entry === null) return null;
  return <ThreadTitleMentions title={getThreadDisplayTitle(entry)} />;
}
