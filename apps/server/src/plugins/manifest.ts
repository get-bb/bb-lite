import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { derivePluginId } from "@bb/domain";
import { z } from "zod";

const OLD_SDK = "@get-bb/plugin-sdk";
const packages = z.record(z.string(), z.unknown()).optional();

const packageSchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
  engines: z.looseObject({ bb: z.string().optional() }).optional(),
  dependencies: packages,
  peerDependencies: packages,
  devDependencies: packages,
  bb: z.object({
    name: z.string().min(1),
    description: z.string().default(""),
    icon: z.string().min(1).optional(),
    branding: z.looseObject({ icon: z.string().min(1).optional() }).optional(),
    server: z.string().min(1).optional(),
    app: z.string().min(1).optional(),
    runner: z.string().min(1).optional(),
    host: z.string().min(1).optional(),
    requires: z
      .union([
        z.array(z.string().min(1)),
        z.record(z.string().min(1), z.string().min(1)),
      ])
      .default([]),
    forkOf: z.string().min(1).optional(),
    enabledByDefault: z.boolean().default(true),
    skills: z.array(z.string().min(1)).default([]),
    themes: z
      .array(
        z.object({
          id: z
            .string()
            .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u)
            .max(64),
          name: z.string().min(1),
          description: z.string().default(""),
          css: z.string().min(1),
          codeTheme: z
            .object({
              dark: z.string().optional(),
              light: z.string().optional(),
            })
            .optional(),
        }),
      )
      .default([]),
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
  version: string | null;
  apiRange: string | null;
  requires: string[];
  requiredVersions: Record<string, string>;
  forkOf: string | null;
  enabledByDefault: boolean;
  skillDirs: string[];
  themes: ManifestTheme[];
}

export interface ManifestTheme {
  id: string;
  name: string;
  description: string;
  cssFile: string;
  codeTheme: CodeThemeSides | null;
  codeThemeFiles: CodeThemeSides;
}

type CodeThemeSides = { dark?: string; light?: string };

function isCodeThemeFile(value: string): boolean {
  return /[/\\]|\.json$/u.test(value);
}

function codeThemeSides(
  declared: CodeThemeSides | undefined,
  inside: (path: string) => string,
) {
  const names: CodeThemeSides = {};
  const files: CodeThemeSides = {};
  for (const side of ["dark", "light"] as const) {
    const value = declared?.[side];
    if (value === undefined) continue;
    if (isCodeThemeFile(value)) files[side] = inside(value);
    else names[side] = value;
  }
  return { codeTheme: declared === undefined ? null : names, files };
}

export function resolveInside(directory: string, path: string): string | null {
  const resolved = resolve(directory, path);
  return resolved.startsWith(directory + sep) ? resolved : null;
}

export async function readManifest(path: string): Promise<PluginManifest> {
  const directory = resolve(path);
  const text = await readFile(join(directory, "package.json"), "utf8");
  const result = packageSchema.safeParse(JSON.parse(text));
  if (!result.success) {
    const [issue] = result.error.issues;
    const where = issue?.path.join(".") || "package.json";
    throw new Error(`package.json: ${where}: ${issue?.message}`);
  }
  const parsed = result.data;
  const { name, bb } = parsed;
  const ranged = Array.isArray(bb.requires) ? {} : bb.requires;
  const required = Array.isArray(bb.requires)
    ? bb.requires
    : Object.keys(ranged);
  const runner = bb.runner ?? bb.host;
  const code = [bb.server, bb.app, runner].some((entry) => entry !== undefined);
  const needs = [
    parsed.dependencies,
    parsed.peerDependencies,
    parsed.devDependencies,
  ].some((listed) => listed !== undefined && OLD_SDK in listed);
  if (code && needs) {
    throw new Error(
      `This plugin was written for the original bb plugin SDK (${OLD_SDK}). ` +
        "Port it to this bb with `bb dev port <directory>`.",
    );
  }
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
    icon: bb.icon ?? bb.branding?.icon ?? null,
    serverEntry: bb.server === undefined ? null : inside(bb.server),
    appEntry: bb.app === undefined ? null : inside(bb.app),
    runnerEntry: runner === undefined ? null : inside(runner),
    version: parsed.version ?? null,
    apiRange: parsed.engines?.bb ?? null,
    requires: required,
    requiredVersions: ranged,
    forkOf: bb.forkOf ?? null,
    enabledByDefault: bb.enabledByDefault,
    skillDirs: bb.skills.map(inside),
    themes: bb.themes.map(({ css, codeTheme: declared, ...theme }) => {
      const { codeTheme, files } = codeThemeSides(declared, inside);
      const cssFile = inside(css);
      return { ...theme, cssFile, codeTheme, codeThemeFiles: files };
    }),
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
