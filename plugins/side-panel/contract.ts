import { callPart, part } from "@bb/app-kit/plugins/parts";
import type * as PluginPanelHeaderModule from "./app/components/plugin/PluginPanelHeader";
import type * as PluginPanelRightPanelHostModule from "./app/components/plugin/PluginPanelRightPanelHost";
import type * as UseEnvironmentMergeBaseModule from "./app/components/secondary-panel/git-diff/useEnvironmentMergeBase";
import type * as UseThreadPanelModule from "./app/components/secondary-panel/useThreadPanel";
import type * as PluginPanelViewModule from "./app/views/PluginPanelView";
import type * as SplitWorkspaceSecondaryPanelHostModule from "./app/views/thread-detail/SplitWorkspaceSecondaryPanelHost";
import type * as ThreadDetailSecondaryContentModule from "./app/views/thread-detail/ThreadDetailSecondaryContent";

export const PluginPanelHeaderActions = part<
  typeof PluginPanelHeaderModule.PluginPanelHeaderActions
>("side-panel", "PluginPanelHeaderActions");
export const PluginPanelHeaderCenter = part<
  typeof PluginPanelHeaderModule.PluginPanelHeaderCenter
>("side-panel", "PluginPanelHeaderCenter");
export const PluginPanelRightPanelHost = part<
  typeof PluginPanelRightPanelHostModule.PluginPanelRightPanelHost
>("side-panel", "PluginPanelRightPanelHost");
export const useEnvironmentMergeBase = callPart<
  typeof UseEnvironmentMergeBaseModule.useEnvironmentMergeBase
>("side-panel", "useEnvironmentMergeBase");
export const openThreadLink = callPart<
  typeof UseThreadPanelModule.openThreadLink
>("side-panel", "openThreadLink");
export const useThreadPanel = callPart<
  typeof UseThreadPanelModule.useThreadPanel
>("side-panel", "useThreadPanel");
export const PluginPanelView = part<
  typeof PluginPanelViewModule.PluginPanelView
>("side-panel", "PluginPanelView");
export const SplitWorkspaceSecondaryPanelHost = part<
  typeof SplitWorkspaceSecondaryPanelHostModule.SplitWorkspaceSecondaryPanelHost
>("side-panel", "SplitWorkspaceSecondaryPanelHost");
export const ThreadDetailSecondaryContent = part<
  typeof ThreadDetailSecondaryContentModule.ThreadDetailSecondaryContent
>("side-panel", "ThreadDetailSecondaryContent");
