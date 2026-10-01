import { definePluginApp, type PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PreferencesSync } from "./app/preferences/PreferencesSync.js";
import { ProjectList } from "./app/list/ProjectList.js";
import { useSidebarThreadReveal } from "./app/list/useSidebarThreadReveal.js";

function ThreadList({ activeThreadId }: PluginThreadListProps) {
  useSidebarThreadReveal();
  return (
    <TooltipProvider>
      <PreferencesSync />
      <ProjectList activeThreadId={activeThreadId} />
    </TooltipProvider>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadList({
    id: "thread-list",
    title: "Thread list",
    description:
      "Pinned threads, custom sections, projects, machines, and nested threads.",
    component: ThreadList,
  });
});
