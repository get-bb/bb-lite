import { fileURLToPath } from "node:url";
import { derivePluginId } from "@bb/domain";
import type { PluginServerEntry } from "@bb/plugin";
import { serverEntries } from "./builtins.server.js";
import { CORE, LOADED_FIRST, profiles } from "./profiles.js";

export interface BuiltinPlugin {
  directory: string;
  server: PluginServerEntry | null;
  core?: boolean;
}

function builtin(id: string): BuiltinPlugin {
  const directory = fileURLToPath(
    new URL(`../../plugins/${id}`, import.meta.url),
  );
  return { directory, server: serverEntries[id] ?? null };
}

const others = Object.keys(serverEntries)
  .filter((id) => !CORE.includes(id) && !LOADED_FIRST.includes(id))
  .sort();

export const corePlugins: BuiltinPlugin[] = CORE.map(builtin);

export const serverPlugins: BuiltinPlugin[] = [...LOADED_FIRST, ...others].map(
  builtin,
);

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
