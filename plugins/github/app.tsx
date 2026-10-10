import { composer, type PluginAppApi, shell, sidePanel } from "@bb/plugin/app";
import { PullRequestAction, PullRequestSegment } from "./app/banner.js";
import { GithubHeader, GithubPanel } from "./app/panel.js";
import { PullPanelTab } from "./app/pull.js";

export default function githubApp(bb: PluginAppApi): void {
  bb.add(shell.navPanel, {
    id: "github",
    title: "GitHub",
    icon: "Github",
    path: "github",
    view: GithubPanel,
    headerView: GithubHeader,
  });
  bb.add(sidePanel.panel, {
    id: "pull",
    title: "GitHub PR",
    icon: "Github",
    view: PullPanelTab,
    layout: "flush",
  });
  bb.add(composer.contextSegment, {
    id: "pull-request",
    segment: PullRequestSegment,
    action: PullRequestAction,
  });
}
