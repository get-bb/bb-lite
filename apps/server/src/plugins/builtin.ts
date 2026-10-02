import { fileURLToPath } from "node:url";
import type { PluginServerEntry } from "@bb/plugin";
import askUserQuestion from "../../../../plugins/ask-user-question/src/server.js";
import customInstructions from "../../../../plugins/custom-instructions/server.js";
import secrets from "../../../../plugins/secrets/src/server.js";
import threadList from "../../../../plugins/thread-list/server.js";

export interface BuiltinPlugin {
  directory: string;
  server: PluginServerEntry | null;
}

const pluginDirectory = (name: string): string =>
  fileURLToPath(new URL(`../../../../plugins/${name}`, import.meta.url));

export const builtinPlugins: BuiltinPlugin[] = [
  { directory: pluginDirectory("thread-list"), server: threadList },
  { directory: pluginDirectory("navigation"), server: null },
  { directory: pluginDirectory("secrets"), server: secrets },
  { directory: pluginDirectory("ask-user-question"), server: askUserQuestion },
  {
    directory: pluginDirectory("custom-instructions"),
    server: customInstructions,
  },
];
