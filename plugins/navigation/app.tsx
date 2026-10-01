import { definePluginApp } from "@bb/plugin/app";
import { Navigation } from "./app/Navigation.js";

export default definePluginApp((app) => {
  app.slots.sidebarNavigation({
    id: "navigation",
    title: "Navigation",
    description: "New thread, Search, and plugin panels as sidebar rows.",
    component: Navigation,
  });
});
