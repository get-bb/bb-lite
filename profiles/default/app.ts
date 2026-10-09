import type { PluginAppEntry } from "@bb/plugin/app";
import composer from "../../plugins/composer/app";
import settings from "../../plugins/settings/app";
import shell from "../../plugins/shell/app";
import sidePanel from "../../plugins/side-panel/app";
import threadView from "../../plugins/thread-view/app";

export interface BuiltinAppPlugin {
  id: string;
  load: () => Promise<{ default: PluginAppEntry }>;
}

export interface CoreAppPlugin extends BuiltinAppPlugin {
  app: PluginAppEntry;
}

function core(id: string, app: PluginAppEntry): CoreAppPlugin {
  return { id, app, load: async () => ({ default: app }) };
}

export const coreAppPlugins: readonly CoreAppPlugin[] = [
  core("shell", shell),
  core("thread-view", threadView),
  core("composer", composer),
  core("side-panel", sidePanel),
  core("settings", settings),
];

export const appPlugins: readonly BuiltinAppPlugin[] = [
  {
    id: "thread-list",
    load: () => import("../../plugins/thread-list/app"),
  },
  {
    id: "navigation",
    load: () => import("../../plugins/navigation/app"),
  },
  { id: "tasks", load: () => import("../../plugins/tasks/app") },
  { id: "bb-guide", load: () => import("../../plugins/bb-guide/app") },
  { id: "drafts", load: () => import("../../plugins/drafts/app") },
  {
    id: "plugin-api-tester",
    load: () => import("../../plugins/plugin-api-tester/app"),
  },
  {
    id: "connect",
    load: () => import("../../plugins/connect/app"),
  },
  {
    id: "secrets",
    load: () => import("../../plugins/secrets/app"),
  },
  {
    id: "ask-user-question",
    load: () => import("../../plugins/ask-user-question/app"),
  },
  {
    id: "account-pool",
    load: () => import("../../plugins/account-pool/app"),
  },
  {
    id: "pdf-preview",
    load: () => import("../../plugins/pdf-preview/app"),
  },
];
