import { definePluginApp, type PluginThreadListProps } from "@bb/plugin/app";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { PreferencesSync } from "./app/preferences.js";
import { ThreadList } from "./app/list/ThreadList.js";
import { useSidebarThreadReveal } from "./app/list/useSidebarThreadReveal.js";

function ThreadListSlot({ activeThreadId }: PluginThreadListProps) {
  useSidebarThreadReveal();
  return (
    <TooltipProvider>
      <PreferencesSync />
      <ThreadList activeThreadId={activeThreadId} />
    </TooltipProvider>
  );
}

export default definePluginApp((app) => {
  app.slots.threadList({
    id: "thread-list",
    title: "Thread list",
    description: "Pinned threads, custom sections, and nested threads.",
    component: ThreadListSlot,
  });
});
