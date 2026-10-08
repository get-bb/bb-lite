import { type PluginAppApi, shell } from "@bb/plugin/app";
import { Navigation } from "./app/Navigation.js";

export default function navigationApp(bb: PluginAppApi): void {
  bb.add(shell.sidebarNavigation, {
    id: "navigation",
    title: "Navigation",
    description: "New thread, Search, and plugin panels as sidebar rows.",
    view: Navigation,
  });
}
