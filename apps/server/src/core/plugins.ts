import type { PluginScope } from "@bb/plugin";
import type { ServerContext } from "../context.js";
import { ensurePersonalProject } from "../db/projects.js";
import { createEnvironments } from "../environments/manager.js";
import { startWorkspaceWatch } from "../environments/watch.js";
import type { RouteGroup } from "../http/api.js";
import { registerEnvironmentRoutes } from "../http/routes/environments.js";
import { registerFileRoutes } from "../http/routes/files.js";
import {
  registerHostRoutes,
  registerRunnerRoutes,
} from "../http/routes/hosts.js";
import { registerKernelRoutes } from "../http/routes/kernel.js";
import { registerPluginRoutes } from "../http/routes/plugins.js";
import { registerProjectRoutes } from "../http/routes/projects.js";
import { registerProviderRoutes } from "../http/routes/providers.js";
import { registerSettingsRoutes } from "../http/routes/settings.js";
import { registerTerminalRoutes } from "../http/routes/terminals.js";
import { registerThreadReadRoutes } from "../http/routes/thread-read.js";
import { registerThreadRoutes } from "../http/routes/threads.js";
import { registerUserRoutes } from "../http/routes/users.js";
import { startPlugins } from "../plugins/host.js";
import { ensureLocalHost } from "../runners/hosts.js";
import { startTerminalSessions } from "../terminals/sessions.js";
import { createThreadEngine } from "../threads/engine.js";
import * as ops from "./ops.js";

type MaybePromise<T> = T | Promise<T>;
export type Disposer = () => void | Promise<void>;

export interface CorePlugin {
  id: string;
  description: string;
  requires?: readonly string[];
  routes?: readonly RouteGroup[];
  internalRoutes?: readonly RouteGroup[];
  setup?(ctx: ServerContext, bb: PluginScope): void;
  start?(ctx: ServerContext): MaybePromise<Disposer | void>;
}

export const corePlugins: readonly CorePlugin[] = [
  {
    id: "identity",
    description: "People, sign-in, invites and who a request acts as.",
    routes: [registerUserRoutes],
    setup: ops.userOps,
  },
  {
    id: "settings",
    description: "General settings, appearance, keybindings and preferences.",
    routes: [registerSettingsRoutes],
  },
  {
    id: "projects",
    description: "Projects, their sources and attachments.",
    routes: [registerProjectRoutes],
    setup: ops.projectOps,
    start: ({ db }) => ensurePersonalProject(db),
  },
  {
    id: "machines",
    description: "Machines, enrollment, sharing and the link to each runner.",
    routes: [registerHostRoutes],
    internalRoutes: [registerRunnerRoutes],
    setup: ops.machineOps,
    start: (ctx) => ensureLocalHost(ctx),
  },
  {
    id: "sessions",
    description:
      "What a provider session starts from: providers, models, " +
      "instructions, tools and environment variables.",
    routes: [registerProviderRoutes],
    setup: ops.sessionOps,
  },
  {
    id: "plugins",
    description: "Loads plugins and serves operations to apps and the CLI.",
    requires: ["threads", "environments"],
    routes: [registerPluginRoutes, registerKernelRoutes],
    setup: ops.pluginOps,
    start: (ctx) => startPlugins(ctx),
  },
  {
    id: "environments",
    description: "The directory a thread runs in: create, set up, retire.",
    requires: ["threads"],
    routes: [registerEnvironmentRoutes],
    setup(ctx) {
      ctx.environments = createEnvironments(ctx);
    },
    start: (ctx) => ctx.environments.start(),
  },
  {
    id: "workspace",
    description: "Files, git state and diffs in a thread's directory.",
    requires: ["terminals"],
    routes: [registerFileRoutes],
    setup: ops.fileOps,
    start: (ctx) => startWorkspaceWatch(ctx),
  },
  {
    id: "terminals",
    description: "Terminal sessions on machines.",
    requires: ["plugins"],
    routes: [registerTerminalRoutes],
    start: (ctx) => startTerminalSessions(ctx),
  },
  {
    id: "threads",
    description: "Threads, turns, the message queue and the event log.",
    requires: ["machines", "projects"],
    routes: [registerThreadRoutes, registerThreadReadRoutes],
    setup(ctx, bb) {
      ctx.threads = createThreadEngine(ctx);
      ops.threadReadOps(ctx, bb);
    },
    start(ctx) {
      ctx.threads.start();
      return () => ctx.threads.close();
    },
  },
  {
    id: "interactions",
    description: "Questions and approvals waiting on a person.",
    setup: ops.interactionOps,
  },
  {
    id: "audit-log",
    description: "The record of who changed what, and through which plugin.",
    setup: ops.auditOps,
  },
];

export function inStartOrder(
  plugins: readonly CorePlugin[],
): readonly CorePlugin[] {
  const ordered: CorePlugin[] = [];
  const visit = (plugin: CorePlugin, trail: readonly string[]) => {
    if (ordered.includes(plugin) || trail.includes(plugin.id)) return;
    for (const required of plugin.requires ?? []) {
      const needed = plugins.find(({ id }) => id === required);
      if (needed !== undefined) visit(needed, [...trail, plugin.id]);
    }
    ordered.push(plugin);
  };
  for (const plugin of plugins) visit(plugin, []);
  return ordered;
}
