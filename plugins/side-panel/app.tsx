import { lazy, type ComponentType } from "react";
import {
  app,
  sidePanel,
  type SidePanelTabProps,
  type PluginAppApi,
} from "@bb/plugin/app";
import {
  FileTabIcon,
  NewTabIcon,
  PluginPanelTabIcon,
  TerminalTabIcon,
  fileTabTitle,
  pluginPanelTabTitle,
} from "./app/components/secondary-panel/SidePanelTabChrome";
import { loadWithDownloadRetries } from "@bb/app-kit/lib/chunk-load";
import * as parts from "./parts";

type Views =
  typeof import("./app/components/secondary-panel/SidePanelTabViews");

function view(name: keyof Views): ComponentType<SidePanelTabProps> {
  return lazy(async () => {
    const views = await loadWithDownloadRetries(
      () => import("./app/components/secondary-panel/SidePanelTabViews"),
    );
    return { default: views[name] };
  });
}

export default function sidePanelApp(bb: PluginAppApi): void {
  bb.add(app.parts, { plugin: "side-panel", parts });
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
}
