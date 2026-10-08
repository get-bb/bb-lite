import { contract, op } from "@bb/plugin";
import { z } from "zod";

const located = {
  path: z.string().describe("The plugin's directory"),
  cwd: z.string().optional().describe("Directory a relative path starts from"),
};

const uses = z.array(z.object({ target: z.string(), file: z.string() }));

export const reportSchema = z.object({
  id: z.string().nullable(),
  name: z.string().nullable(),
  directory: z.string(),
  parts: z.array(z.enum(["server", "app", "runner"])),
  requires: z.array(z.string()),
  implements: uses,
  hooks: uses,
  calls: uses,
  emits: uses,
  adds: uses,
  wraps: uses,
  provides: uses,
  reaches: z.array(z.object({ what: z.string(), file: z.string() })),
  legacy: z.array(z.object({ what: z.string(), file: z.string() })),
  problems: z.array(z.string()),
});
export type Report = z.infer<typeof reportSchema>;

function lines(title: string, entries: { file: string }[], pick: string) {
  if (entries.length === 0) return [];
  const rows = entries.map((entry) => {
    const value = (entry as Record<string, string>)[pick];
    return `  ${value}  (${entry.file})`;
  });
  return [`${title}:`, ...rows];
}

export function printReport(report: Report): string {
  const head = [
    `${report.name ?? "Unnamed plugin"} (${report.id ?? "no id"})`,
    `  parts: ${report.parts.join(", ") || "none"}`,
    `  requires: ${report.requires.join(", ") || "nothing"}`,
  ];
  const body = [
    ...lines("implements", report.implements, "target"),
    ...lines("hooks", report.hooks, "target"),
    ...lines("calls", report.calls, "target"),
    ...lines("emits", report.emits, "target"),
    ...lines("adds to", report.adds, "target"),
    ...lines("wraps", report.wraps, "target"),
    ...lines("provides", report.provides, "target"),
    ...lines("reaches outside bb through", report.reaches, "what"),
    ...lines("uses the old plugin API", report.legacy, "what"),
  ];
  const problems =
    report.problems.length === 0
      ? ["No problems found."]
      : ["problems:", ...report.problems.map((problem) => `  ${problem}`)];
  return [...head, ...body, ...problems].join("\n");
}

export const pluginDev = contract("plugin-dev", {
  inspect: op({
    input: z.object({
      name: z
        .string()
        .optional()
        .describe("An operation, event or slot name, or a prefix of one"),
    }),
    output: z.string(),
    doors: {
      cli: {
        path: "dev inspect",
        summary: "List the live operations, slots and hooks",
        positionals: ["name"],
      },
    },
  }),
  validate: op({
    input: z.object(located),
    output: reportSchema,
    doors: {
      cli: {
        path: "dev validate",
        summary: "Check a plugin directory and list what it touches",
        positionals: ["path"],
        print: printReport,
      },
    },
  }),
  scaffold: op({
    input: z.object({
      name: z.string().describe("Plugin id: lower-case letters and dashes"),
      path: z.string().optional().describe("Where to create it"),
      cwd: located.cwd,
    }),
    output: z.object({ path: z.string(), files: z.array(z.string()) }),
    kind: "write",
    allow: "owner",
    doors: {
      cli: {
        path: "dev new",
        summary: "Create a plugin directory to start from",
        positionals: ["name"],
        print: ({ path, files }) =>
          [`Created ${path}`, ...files.map((file) => `  ${file}`)].join("\n"),
      },
    },
  }),
  types: op({
    input: z.object(located),
    output: z.object({ file: z.string() }),
    kind: "write",
    allow: "owner",
    doors: {
      cli: {
        path: "dev types",
        summary: "Write a tsconfig that resolves bb's types for a plugin",
        positionals: ["path"],
        print: ({ file }) => `Wrote ${file}`,
      },
    },
  }),
  watch: op({
    input: z.object(located),
    output: z.object({ id: z.string().nullable(), path: z.string() }),
    kind: "write",
    allow: "owner",
    doors: {
      cli: {
        path: "dev watch",
        summary: "Load a plugin directory and reload it when files change",
        positionals: ["path"],
        print: ({ id, path }) =>
          `Loaded ${id ?? path}; it reloads when its files change`,
      },
    },
  }),
  install: op({
    input: z.object({
      source: z
        .string()
        .describe("git:<url>[#ref], npm:<package>[@version] or a directory"),
      cwd: located.cwd,
    }),
    output: z.object({ id: z.string().nullable(), path: z.string() }),
    kind: "write",
    allow: "owner",
    doors: {
      cli: {
        path: "dev install",
        summary: "Fetch a plugin from git or npm and load it",
        positionals: ["source"],
        print: ({ id, path }) => `Installed ${id ?? "plugin"} at ${path}`,
      },
    },
  }),
});
