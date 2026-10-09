import { contract, live, op } from "@bb/plugin";
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
  commit: z.string().nullable().optional(),
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

const newerSchema = z.object({ version: z.string(), needsBb: z.string() });

const updateSchema = z.object({
  id: z.string(),
  version: z.string().nullable(),
  latest: z.string(),
});

const updatedSchema = installedSchema.extend({
  newer: newerSchema.nullable().optional(),
});

const catalogSourceSchema = z.object({
  url: z.string(),
  entries: z.number().nullable(),
  refreshedAt: z.number().nullable(),
  error: z.string().nullable(),
});
export type CatalogSource = z.infer<typeof catalogSourceSchema>;

const byUrl = z.object({
  url: z.string().min(1).describe("An https catalog URL or a local file"),
});

const printCatalogs = (rows: CatalogSource[]) =>
  rows
    .map((row) => {
      const state =
        row.error === null ? `${row.entries ?? "?"} plugins` : row.error;
      return `${row.url}  ${state}`;
    })
    .join("\n");

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
        aliases: ["plugin search"],
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
        path: "marketplace plugins",
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
        aliases: ["plugin install"],
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
        aliases: ["marketplace outdated", "plugin outdated"],
        summary: "List marketplace plugins with a newer version in range",
        print: (rows) =>
          rows
            .map((row) => `${row.id} ${row.version ?? "?"} -> ${row.latest}`)
            .join("\n"),
      },
    },
  }),
  update: op({
    input: byId.extend({
      force: z
        .boolean()
        .optional()
        .describe("Update even when the installed tag has moved"),
    }),
    output: updatedSchema,
    kind: "write",
    allow: "owner",
    doors: {
      cli: {
        path: "marketplace update",
        aliases: ["plugin update"],
        summary: "Update a marketplace plugin to the newest version in range",
        positionals: ["id"],
        print: ({ id, version, newer }) =>
          [
            `${id} is at ${version ?? "?"}`,
            ...(newer ? [`${newer.version} needs bb ${newer.needsBb}`] : []),
          ].join("\n"),
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
        path: "marketplace uninstall",
        summary: "Remove a plugin installed from the marketplace",
        positionals: ["id"],
        print: ({ id }) => `Removed ${id}`,
      },
    },
  }),
  catalogs: op({
    input: z.object({}),
    output: z.array(catalogSourceSchema),
    doors: {
      cli: {
        path: "marketplace list",
        summary: "List the catalogs bb offers plugins from",
        print: printCatalogs,
      },
    },
  }),
  addCatalog: op({
    input: byUrl,
    output: z.array(catalogSourceSchema),
    kind: "write",
    allow: "owner",
    doors: {
      cli: {
        path: "marketplace add",
        summary: "Add a catalog (reads it; installs nothing)",
        positionals: ["url"],
        print: printCatalogs,
      },
    },
  }),
  removeCatalog: op({
    input: byUrl,
    output: z.array(catalogSourceSchema),
    kind: "write",
    allow: "owner",
    doors: {
      cli: {
        path: "marketplace remove",
        summary: "Forget a catalog; installed plugins stay",
        positionals: ["url"],
        print: printCatalogs,
      },
    },
  }),
  refresh: op({
    input: z.object({ url: z.string().optional() }),
    output: z.array(catalogSourceSchema),
    kind: "write",
    allow: "owner",
    doors: {
      cli: {
        path: "marketplace refresh",
        summary: "Re-read one catalog or all of them (never installs)",
        positionals: ["url"],
        print: printCatalogs,
      },
    },
  }),
  available: live(z.number(), {
    description: "How many installed plugins have an update",
  }),
});
