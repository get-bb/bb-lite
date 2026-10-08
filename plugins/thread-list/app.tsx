import { plugin, type PluginThreadListProps } from "@bb/plugin/app";
import { CompactViewportOverrideProvider } from "@bb/shared-ui/hooks/use-compact-viewport";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { PreferencesSync } from "./app/preferences.js";
import { ThreadList } from "./app/list/ThreadList.js";
import { useSidebarThreadReveal } from "./app/list/useSidebarThreadReveal.js";

function ThreadListSlot({
  activeThreadId,
  isCompactViewport,
  onNavigate,
}: PluginThreadListProps) {
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

export default plugin((bb) => {
  bb.slots.threadList({
    id: "thread-list",
    title: "Thread list",
    description: "Pinned threads, custom sections, and nested threads.",
    component: ThreadListSlot,
  });
});
