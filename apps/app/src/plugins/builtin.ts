import type { PluginAppDefinition } from "@bb/plugin/app";

export interface BuiltinPlugin {
  id: string;
  load: () => Promise<{ default: PluginAppDefinition }>;
}

export const BUILTIN_PLUGINS: readonly BuiltinPlugin[] = [
  {
    id: "thread-list",
    load: () => import("../../../../plugins/thread-list/app"),
  },
  {
    id: "navigation",
    load: () => import("../../../../plugins/navigation/app"),
  },
  {
    id: "connect",
    load: () => import("../../../../plugins/connect/app"),
  },
  {
    id: "secrets",
    load: () => import("../../../../plugins/secrets/app"),
  },
  {
    id: "ask-user-question",
    load: () => import("../../../../plugins/ask-user-question/app"),
  },
];
