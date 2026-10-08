import { part } from "@bb/app-kit/plugins/parts";
import type * as PluginThreadChatModule from "./app/components/plugin/PluginThreadChat";
import type * as PluginThreadTitleModule from "./app/components/plugin/PluginThreadTitle";
import type * as ThreadTerminalPanelModule from "./app/components/thread/terminal/ThreadTerminalPanel";
import type * as TimelineModule from "./app/components/thread/timeline";
import type * as PaneMaximizeButtonModule from "./app/views/thread-detail/PaneMaximizeButton";
import type * as SplitThreadAreaModule from "./app/views/thread-detail/SplitThreadArea";
import type * as ThreadTimelinePaneModule from "./app/views/thread-detail/ThreadTimelinePane";

export type {
  ThreadTimelineLocalFileLink,
  ThreadTimelineOpenPluginPanelHandler,
} from "./app/components/thread/timeline";

export const PluginThreadChat = part<
  typeof PluginThreadChatModule.PluginThreadChat
>("thread-view", "PluginThreadChat");
export const PluginThreadTitle = part<
  typeof PluginThreadTitleModule.PluginThreadTitle
>("thread-view", "PluginThreadTitle");
export const ThreadTerminalPanel = part<
  typeof ThreadTerminalPanelModule.ThreadTerminalPanel
>("thread-view", "ThreadTerminalPanel");
export const ThreadContextWindowIndicator = part<
  typeof TimelineModule.ThreadContextWindowIndicator
>("thread-view", "ThreadContextWindowIndicator");
export const PaneArrangementButton = part<
  typeof PaneMaximizeButtonModule.PaneArrangementButton
>("thread-view", "PaneArrangementButton");
export const SplitThreadArea = part<
  typeof SplitThreadAreaModule.SplitThreadArea
>("thread-view", "SplitThreadArea");
export const ThreadTimelinePane = part<
  typeof ThreadTimelinePaneModule.ThreadTimelinePane
>("thread-view", "ThreadTimelinePane");
