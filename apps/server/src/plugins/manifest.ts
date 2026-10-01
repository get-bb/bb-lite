import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { derivePluginId } from "@bb/domain";
import { z } from "zod";

const packageSchema = z.object({
  name: z.string().min(1),
  bb: z.object({
    name: z.string().min(1),
    description: z.string().default(""),
    icon: z.string().min(1).optional(),
    server: z.string().min(1).optional(),
    app: z.string().min(1).optional(),
    skills: z.array(z.string().min(1)).default([]),
  }),
});

const configSchema = z.object({
  plugins: z
    .array(
      z.object({ path: z.string().min(1), enabled: z.boolean().default(true) }),
    )
    .default([]),
});

export interface PluginManifest {
  id: string;
  directory: string;
  name: string;
  description: string;
  icon: string | null;
  serverEntry: string | null;
  appEntry: string | null;
  skillDirs: string[];
}

export function resolveInside(directory: string, path: string): string | null {
  const resolved = resolve(directory, path);
  return resolved.startsWith(directory + sep) ? resolved : null;
}

export async function readManifest(path: string): Promise<PluginManifest> {
  const directory = resolve(path);
  const text = await readFile(join(directory, "package.json"), "utf8");
  const { name, bb } = packageSchema.parse(JSON.parse(text));
  const inside = (entry: string): string => {
    const resolved = resolveInside(directory, entry);
    if (resolved !== null) return resolved;
    throw new Error(`"${entry}" is outside the plugin directory`);
  };
  return {
    id: derivePluginId(name),
    directory,
    name: bb.name,
    description: bb.description,
    icon: bb.icon ?? null,
    serverEntry: bb.server === undefined ? null : inside(bb.server),
    appEntry: bb.app === undefined ? null : inside(bb.app),
    skillDirs: bb.skills.map(inside),
  };
}

export async function readExternalPluginEntries(configFile: string) {
  const text = await readFile(configFile, "utf8").catch(() => "{}");
  return configSchema.parse(JSON.parse(text)).plugins;
}
