import { callPart, part } from "@bb/app-kit/plugins/parts";
import type * as AppLayoutModule from "./app/components/layout/AppLayout";
import type * as SidebarNavigationModelModule from "./app/components/sidebar/SidebarNavigationModel";
import type * as PluginSidebarHooksModule from "./app/lib/plugin-sidebar-hooks";

export const AppLayout = part<typeof AppLayoutModule.AppLayout>(
  "shell",
  "AppLayout",
);
export const SidebarNavigationIcon = part<
  typeof SidebarNavigationModelModule.SidebarNavigationIcon
>("shell", "SidebarNavigationIcon");
export const useSidebarNavigation = callPart<
  typeof PluginSidebarHooksModule.useSidebarNavigation
>("shell", "useSidebarNavigation");
export const useSidebarSplitLayout = callPart<
  typeof PluginSidebarHooksModule.useSidebarSplitLayout
>("shell", "useSidebarSplitLayout");
export const useSidebarThreadActions = callPart<
  typeof PluginSidebarHooksModule.useSidebarThreadActions
>("shell", "useSidebarThreadActions");
export const useSidebarThreadDraft = callPart<
  typeof PluginSidebarHooksModule.useSidebarThreadDraft
>("shell", "useSidebarThreadDraft");
export const useSidebarThreadDraftIds = callPart<
  typeof PluginSidebarHooksModule.useSidebarThreadDraftIds
>("shell", "useSidebarThreadDraftIds");
export const useSidebarThreadEntry = callPart<
  typeof PluginSidebarHooksModule.useSidebarThreadEntry
>("shell", "useSidebarThreadEntry");
export const useSidebarThreadShortcut = callPart<
  typeof PluginSidebarHooksModule.useSidebarThreadShortcut
>("shell", "useSidebarThreadShortcut");
export const useSidebarNavigationSplit = callPart<
  typeof PluginSidebarHooksModule.useSidebarNavigationSplit
>("shell", "useSidebarNavigationSplit");
export const useSidebarThreadSplit = callPart<
  typeof PluginSidebarHooksModule.useSidebarThreadSplit
>("shell", "useSidebarThreadSplit");
export const useSidebarThreads = callPart<
  typeof PluginSidebarHooksModule.useSidebarThreads
>("shell", "useSidebarThreads");
