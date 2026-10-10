import {
  type ShellThreadListProps,
  type PluginAppApi,
  shell,
} from "@bb/plugin/app";
import { CompactViewportOverrideProvider } from "@bb/shared-ui/hooks/use-compact-viewport";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { PreferencesSync } from "./app/preferences.js";
import { ThreadList } from "./app/list/ThreadList.js";
import { useSidebarThreadReveal } from "./app/list/useSidebarThreadReveal.js";

function ThreadListSlot({
  activeThreadId,
  isCompactViewport,
  onNavigate,
}: ShellThreadListProps) {
  useSidebarThreadReveal();
  return (
    <CompactViewportOverrideProvider isCompactViewport={isCompactViewport}>
      <TooltipProvider>
        <PreferencesSync />
        <ThreadList
          activeThreadId={activeThreadId}
          onProjectSelect={onNavigate}
        />
      </TooltipProvider>
    </CompactViewportOverrideProvider>
  );
}

export default function threadListApp(bb: PluginAppApi): void {
  bb.add(shell.threadList, {
    id: "thread-list",
    title: "Thread list",
    description: "Pinned threads, custom sections, and nested threads.",
    view: ThreadListSlot,
  });
}
