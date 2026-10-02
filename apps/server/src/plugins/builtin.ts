import { fileURLToPath } from "node:url";
import type { PluginServerEntry } from "@bb/plugin";
import connect from "../../../../plugins/connect/src/server.js";
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
  { directory: pluginDirectory("connect"), server: connect },
];
