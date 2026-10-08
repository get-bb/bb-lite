import { plugin } from "@bb/plugin/app";
import { TasksAppShell } from "./shell/app-shell.js";
import { TasksNavigationPanel } from "./shell/sidebar.js";
import { TaskDirectiveCard, TaskEmbedPanel } from "./views/embed/index.js";

export default plugin((bb) => {
  bb.slots.navPanel({
    id: "tasks",
    title: "Tasks",
    icon: "ListTodo",
    path: "tasks",
    component: TasksAppShell,
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
  bb.slots.threadPanel({
    id: "task",
    title: "Task",
    icon: "ListTodo",
    component: TaskEmbedPanel,
  });
  bb.slots.messageDirective({ id: "task", component: TaskDirectiveCard });
});
