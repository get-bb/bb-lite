import { callPart, part } from "@bb/app-kit/plugins/parts";
import type * as AppLayoutModule from "./app/components/layout/AppLayout";
import type * as PluginSidebarHooksModule from "./app/lib/plugin-sidebar-hooks";

export const AppLayout = part<typeof AppLayoutModule.AppLayout>(
  "shell",
  "AppLayout",
);
export const useSidebarThreadEntry = callPart<
  typeof PluginSidebarHooksModule.useSidebarThreadEntry
>("shell", "useSidebarThreadEntry");
