import { lazy, type ComponentType } from "react";
import {
  definePluginApp,
  sidePanel,
  type SidePanelTabProps,
} from "@bb/plugin/app";
import {
  FileTabIcon,
  NewTabIcon,
  PluginPanelTabIcon,
  TerminalTabIcon,
  fileTabTitle,
  pluginPanelTabTitle,
} from "@/components/secondary-panel/SidePanelTabChrome";

type Views = typeof import("@/components/secondary-panel/SidePanelTabViews");

function view(name: keyof Views): ComponentType<SidePanelTabProps> {
  return lazy(async () => {
    const views =
      await import("@/components/secondary-panel/SidePanelTabViews");
    return { default: views[name] };
  });
}

export default definePluginApp((bb) => {
  bb.add(sidePanel.tab, {
    kind: "new-tab",
    title: () => "New tab",
    icon: NewTabIcon,
    view: view("NewTabView"),
  });
  bb.add(sidePanel.tab, {
    kind: "workspace-file-preview",
    title: fileTabTitle,
    icon: FileTabIcon,
    view: view("WorkspaceFilePreviewTabView"),
  });
  bb.add(sidePanel.tab, {
    kind: "host-file-preview",
    title: fileTabTitle,
    icon: FileTabIcon,
    view: view("HostFilePreviewTabView"),
  });
  bb.add(sidePanel.tab, {
    kind: "terminal",
    title: () => "Terminal",
    icon: TerminalTabIcon,
    view: view("TerminalTabView"),
  });
  bb.add(sidePanel.tab, {
    kind: "plugin-panel",
    title: pluginPanelTabTitle,
    icon: PluginPanelTabIcon,
    view: view("PluginPanelTabView"),
  });
});
