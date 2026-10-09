import { contract, op } from "@bb/plugin";
import { z } from "zod";

export const entrySourceSchema = z.union([
  z.object({
    npm: z.object({
      package: z.string(),
      range: z.string().optional(),
      tag: z.string().optional(),
      registry: z.string().optional(),
    }),
  }),
  z.object({
    git: z.object({
      url: z.string(),
      subdir: z.string().optional(),
      ref: z.string().optional(),
      range: z.string().optional(),
      tagPrefix: z.string().optional(),
    }),
  }),
  z.object({ bundled: z.object({ plugin: z.string() }) }),
]);
export type EntrySource = z.infer<typeof entrySourceSchema>;

export const catalogEntrySchema = z.looseObject({
  id: z.string(),
  displayName: z.string().optional(),
  description: z.string().default(""),
  icon: z.unknown().optional(),
  author: z.looseObject({ name: z.string() }).optional(),
  tags: z.array(z.string()).optional(),
  source: entrySourceSchema,
  engines: z.looseObject({ bb: z.string().optional() }).optional(),
  parts: z.array(z.enum(["server", "app", "runner"])).optional(),
});
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

export const catalogFileSchema = z.looseObject({
  name: z.string().optional(),
  displayName: z.string().optional(),
  plugins: z.array(z.unknown()),
});

export const installedSchema = z.object({
  id: z.string(),
  pluginId: z.string().nullable(),
  catalog: z.string(),
  source: z.string(),
  ref: z.string().nullable(),
  range: z.string().nullable(),
  tagPrefix: z.string().nullable(),
  version: z.string().nullable(),
  path: z.string(),
  installedAt: z.number(),
});
export type Installed = z.infer<typeof installedSchema>;

const offeredSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  author: z.string().nullable(),
  catalog: z.string(),
  source: z.string(),
  ref: z.string().nullable(),
  range: z.string().nullable(),
  tagPrefix: z.string().nullable(),
  subdir: z.string().nullable(),
  engine: z.string().nullable(),
  parts: z.array(z.string()).nullable(),
  installable: z.boolean(),
  installed: installedSchema.nullable(),
});
export type Offered = z.infer<typeof offeredSchema>;

const updateSchema = z.object({
  id: z.string(),
  version: z.string().nullable(),
  latest: z.string(),
});

const byId = z.object({ id: z.string().describe("Marketplace entry id") });

export const marketplace = contract("marketplace", {
  catalog: op({
    input: z.object({
      query: z.string().optional(),
      refresh: z.boolean().optional(),
    }),
    output: z.object({
      entries: z.array(offeredSchema),
      errors: z.array(z.object({ catalog: z.string(), message: z.string() })),
    }),
    doors: {
      cli: {
        path: "marketplace search",
        summary: "Search the plugin catalogs",
        positionals: ["query"],
        print: ({ entries }) =>
          entries
            .map((entry) => {
              const state = entry.installed === null ? "" : " (installed)";
              return `${entry.id}${state}  ${entry.description}`;
            })
            .join("\n"),
      },
    },
  }),
  list: op({
    input: z.object({}),
    output: z.array(installedSchema),
    doors: {
      cli: {
        path: "marketplace list",
        summary: "List plugins installed from the marketplace",
        print: (rows) =>
          rows
            .map((row) => `${row.id} ${row.version ?? "?"}  ${row.source}`)
            .join("\n"),
      },
    },
  }),
  install: op({
    input: byId.extend({
      version: z.string().optional().describe("A version or range"),
    }),
    output: installedSchema,
    kind: "write",
    allow: "owner",
    doors: {
      cli: {
        path: "marketplace install",
        summary: "Install a plugin from the marketplace",
        positionals: ["id"],
        print: (row) => `Installed ${row.id} ${row.version ?? ""}`.trim(),
      },
    },
  }),
  updates: op({
    input: z.object({}),
    output: z.array(updateSchema),
    allow: "owner",
    doors: {
      cli: {
        path: "marketplace updates",
        summary: "List marketplace plugins with a newer version in range",
        print: (rows) =>
          rows
            .map((row) => `${row.id} ${row.version ?? "?"} -> ${row.latest}`)
            .join("\n"),
      },
    },
  }),
  update: op({
    input: byId,
    output: installedSchema,
    kind: "write",
    allow: "owner",
    doors: {
      cli: {
        path: "marketplace update",
        summary: "Update a marketplace plugin to the newest version in range",
        positionals: ["id"],
        print: (row) => `Updated ${row.id} to ${row.version ?? "?"}`,
      },
    },
  }),
  uninstall: op({
    input: byId,
    output: z.object({ id: z.string() }),
    kind: "write",
    allow: "owner",
    doors: {
      cli: {
        path: "marketplace remove",
        summary: "Remove a plugin installed from the marketplace",
        positionals: ["id"],
        print: ({ id }) => `Removed ${id}`,
      },
    },
  }),
});
