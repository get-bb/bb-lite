import { fileURLToPath } from "node:url";
import { derivePluginId } from "@bb/domain";
import type { PluginServerEntry } from "@bb/plugin";
import accountPool from "../../plugins/account-pool/src/server.js";
import pluginApiTester from "../../plugins/plugin-api-tester/server.js";
import drafts from "../../plugins/drafts/server.js";
import bbGuide from "../../plugins/bb-guide/server.js";
import askUserQuestion from "../../plugins/ask-user-question/src/server.js";
import audit from "../../plugins/audit/server.js";
import connect from "../../plugins/connect/src/server.js";
import customInstructions from "../../plugins/custom-instructions/server.js";
import pluginDev from "../../plugins/plugin-dev/server.js";
import claudeCode from "../../plugins/provider-claude-code/server.js";
import codex from "../../plugins/provider-codex/server.js";
import echo from "../../plugins/provider-echo/server.js";
import secrets from "../../plugins/secrets/src/server.js";
import tasks from "../../plugins/tasks/server.js";
import threadList from "../../plugins/thread-list/server.js";
import auditLog from "../../plugins/audit-log/server.js";
import environments from "../../plugins/environments/server.js";
import identity from "../../plugins/identity/server.js";
import machines from "../../plugins/machines/server.js";
import projects from "../../plugins/projects/server.js";
import sessions from "../../plugins/sessions/server.js";
import settings from "../../plugins/settings/server.js";
import terminals from "../../plugins/terminals/server.js";
import threads from "../../plugins/threads/server.js";
import workspace from "../../plugins/workspace/server.js";
import { profiles } from "./profiles.js";

export interface BuiltinPlugin {
  directory: string;
  server: PluginServerEntry | null;
  core?: boolean;
}

const pluginDirectory = (name: string) =>
  fileURLToPath(new URL(`../../plugins/${name}`, import.meta.url));

export const corePlugins: BuiltinPlugin[] = [
  { directory: pluginDirectory("identity"), server: identity },
  { directory: pluginDirectory("settings"), server: settings },
  { directory: pluginDirectory("projects"), server: projects },
  { directory: pluginDirectory("machines"), server: machines },
  { directory: pluginDirectory("sessions"), server: sessions },
  { directory: pluginDirectory("threads"), server: threads },
  { directory: pluginDirectory("environments"), server: environments },
  { directory: pluginDirectory("terminals"), server: terminals },
  { directory: pluginDirectory("workspace"), server: workspace },
  { directory: pluginDirectory("audit-log"), server: auditLog },
  { directory: pluginDirectory("shell"), server: null },
  { directory: pluginDirectory("thread-view"), server: null },
  { directory: pluginDirectory("composer"), server: null },
  { directory: pluginDirectory("side-panel"), server: null },
];

export const serverPlugins: BuiltinPlugin[] = [
  { directory: pluginDirectory("provider-codex"), server: codex },
  { directory: pluginDirectory("provider-claude-code"), server: claudeCode },
  { directory: pluginDirectory("provider-echo"), server: echo },
  { directory: pluginDirectory("thread-list"), server: threadList },
  { directory: pluginDirectory("navigation"), server: null },
  { directory: pluginDirectory("secrets"), server: secrets },
  { directory: pluginDirectory("ask-user-question"), server: askUserQuestion },
  {
    directory: pluginDirectory("custom-instructions"),
    server: customInstructions,
  },
  { directory: pluginDirectory("connect"), server: connect },
  { directory: pluginDirectory("audit"), server: audit },
  { directory: pluginDirectory("plugin-dev"), server: pluginDev },
  { directory: pluginDirectory("account-pool"), server: accountPool },
  { directory: pluginDirectory("tasks"), server: tasks },
  { directory: pluginDirectory("bb-guide"), server: bbGuide },
  { directory: pluginDirectory("drafts"), server: drafts },
  {
    directory: pluginDirectory("plugin-api-tester"),
    server: pluginApiTester,
  },
];

export function profilePlugins(name: string): BuiltinPlugin[] {
  const profile = profiles[name];
  if (profile === undefined) {
    const known = Object.keys(profiles).join(", ");
    throw new Error(`Unknown profile "${name}". Use one of: ${known}.`);
  }
  return serverPlugins.filter(({ directory }) => {
    const id = derivePluginId(directory.split(/[\\/]/u).at(-1) ?? "");
    return profile.plugins.includes(id);
  });
}
