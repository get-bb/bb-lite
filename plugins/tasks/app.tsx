import { definePluginApp } from "@bb/plugin/app";
import { TasksAppShell } from "./shell/app-shell.js";
import {
  TasksNavigationPanel,
  TasksSidebarAccessory,
} from "./shell/sidebar.js";
import { TaskDirectiveCard, TaskEmbedPanel } from "./views/embed/index.js";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "tasks",
    title: "Tasks",
    icon: "ListTodo",
    path: "tasks",
    component: TasksAppShell,
    sidebarAccessory: TasksSidebarAccessory,
    fixedTabs: [
      {
        panelId: "tasks",
        id: "navigation",
        title: "Navigation",
        icon: "ListView",
        component: TasksNavigationPanel,
        layout: "flush",
      },
    ],
  });
  app.slots.threadPanel({
    id: "task",
    title: "Task",
    icon: "ListTodo",
    component: TaskEmbedPanel,
  });
  app.slots.messageDirective({ id: "task", component: TaskDirectiveCard });
});
