import {
  type PluginAppApi,
  shell,
  sidePanel,
  threadView,
} from "@bb/plugin/app";
import { TasksAppShell } from "./shell/app-shell.js";
import { TasksNavigationPanel } from "./shell/sidebar.js";
import { TaskDirectiveCard, TaskEmbedPanel } from "./views/embed/index.js";

export default function tasksApp(bb: PluginAppApi): void {
  bb.add(shell.navPanel, {
    id: "tasks",
    title: "Tasks",
    icon: "ListTodo",
    path: "tasks",
    view: TasksAppShell,
    fixedTabs: [
      {
        panelId: "tasks",
        id: "navigation",
        title: "Navigation",
        icon: "ListView",
        view: TasksNavigationPanel,
        layout: "flush",
      },
    ],
  });
  bb.add(sidePanel.panel, {
    id: "task",
    title: "Task",
    icon: "ListTodo",
    view: TaskEmbedPanel,
  });
  bb.add(threadView.messageDirective, { id: "task", view: TaskDirectiveCard });
}
