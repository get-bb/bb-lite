import type { PluginThreadTitleProps } from "@bb/plugin/app";
import { ThreadTitleMentions } from "@/components/thread/ThreadTitleMentions";
import { useSidebarThreadEntry } from "@/lib/plugin-sidebar-hooks";
import { getThreadDisplayTitle } from "@/lib/thread-title";

export function PluginThreadTitle({ threadId }: PluginThreadTitleProps) {
  const entry = useSidebarThreadEntry(threadId);
  if (entry === null) return null;
  return <ThreadTitleMentions title={getThreadDisplayTitle(entry)} />;
}
