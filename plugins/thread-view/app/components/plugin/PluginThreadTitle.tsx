import { ThreadTitleMentions } from "@bb/app-kit/components/thread/ThreadTitleMentions";
import { useSidebarThreadEntry } from "bb-plugin-shell/contract";
import { getThreadDisplayTitle } from "@bb/app-kit/lib/thread-title";

export function PluginThreadTitle({ threadId }: { threadId: string }) {
  const entry = useSidebarThreadEntry(threadId);
  if (entry === null) return null;
  return <ThreadTitleMentions title={getThreadDisplayTitle(entry)} />;
}
