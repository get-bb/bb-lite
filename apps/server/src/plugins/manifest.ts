import { readFile, writeFile } from "node:fs/promises";
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
    runner: z.string().min(1).optional(),
    requires: z.array(z.string().min(1)).default([]),
    forkOf: z.string().min(1).optional(),
    skills: z.array(z.string().min(1)).default([]),
  }),
});

const configSchema = z.object({
  plugins: z
    .array(
      z.object({
        path: z.string().min(1),
        enabled: z.boolean().default(true),
        watch: z.boolean().default(false),
      }),
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
  runnerEntry: string | null;
  requires: string[];
  forkOf: string | null;
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
  const inside = (entry: string) => {
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
    runnerEntry: bb.runner === undefined ? null : inside(bb.runner),
    requires: bb.requires,
    forkOf: bb.forkOf ?? null,
    skillDirs: bb.skills.map(inside),
  };
}

export async function writeExternalPluginEntry(
  configFile: string,
  path: string,
  entry: { watch: boolean } | null,
): Promise<void> {
  const loose = z.looseObject({
    plugins: z.array(z.looseObject({ path: z.string() })).default([]),
  });
  const text = await readFile(configFile, "utf8").catch(() => "{}");
  const config = loose.parse(JSON.parse(text));
  const directory = resolve(path);
  const others = config.plugins.filter(
    (known) => resolve(known.path) !== directory,
  );
  const added = { path: directory, enabled: true, ...entry };
  const plugins = entry === null ? others : [...others, added];
  const next = JSON.stringify({ ...config, plugins }, null, 2);
  await writeFile(configFile, `${next}\n`);
}

export async function readExternalPluginEntries(configFile: string) {
  const text = await readFile(configFile, "utf8").catch(() => "{}");
  return configSchema.parse(JSON.parse(text)).plugins;
}
