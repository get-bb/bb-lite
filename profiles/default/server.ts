import { fileURLToPath } from "node:url";
import { derivePluginId } from "@bb/domain";
import type { PluginServerEntry } from "@bb/plugin";
import accountPool from "../../plugins/account-pool/src/server.js";
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
import { profiles } from "./profiles.js";

export interface BuiltinPlugin {
  directory: string;
  server: PluginServerEntry | null;
}

const pluginDirectory = (name: string) =>
  fileURLToPath(new URL(`../../plugins/${name}`, import.meta.url));

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
