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

export const portStatusSchema = z.enum([
  "same",
  "renamed",
  "changed",
  "feature",
  "none",
]);
export type PortStatus = z.infer<typeof portStatusSchema>;

export const portFindingSchema = z.object({
  id: z.string(),
  status: portStatusSchema,
  now: z.string(),
});
export type PortFinding = z.infer<typeof portFindingSchema>;

const PORT_HEADINGS: [PortStatus, string][] = [
  ["none", "No counterpart"],
  ["feature", "Needs a feature this bb does not have"],
  ["changed", "Works differently"],
  ["renamed", "Renamed"],
  ["same", "Unchanged"],
];

export function printPortReport(findings: readonly PortFinding[]): string {
  if (findings.length === 0) {
    return "No use of the original bb plugin SDK found.";
  }
  const lines: string[] = [];
  for (const [status, heading] of PORT_HEADINGS) {
    const group = findings.filter((finding) => finding.status === status);
    if (group.length === 0) continue;
    lines.push(`${heading} (${group.length})`);
    if (status === "same") {
      lines.push(`  ${group.map(({ id }) => id).join(", ")}`);
    } else {
      for (const { id, now } of group) lines.push(`  ${id}\n    ${now}`);
    }
  }
  return lines.join("\n");
}

export const machinePartsSchema = z.array(
  z.object({
    id: z.string(),
    tier: z.enum(["policy", "installed", "product"]),
    implements: z.array(z.string()),
  }),
);
export type MachineParts = z.infer<typeof machinePartsSchema>;

export const upgradeChangeSchema = z.object({
  member: z.string(),
  kind: z.enum(["breaking", "additive"]),
  change: z.string(),
});
export type UpgradeChange = z.infer<typeof upgradeChangeSchema>;

export const upgradeReportSchema = z.object({
  from: z.string(),
  to: z.string(),
  range: z.object({ before: z.string(), after: z.string() }),
  uses: z.array(z.string()),
  changes: z.array(upgradeChangeSchema),
});
export type UpgradeReport = z.infer<typeof upgradeReportSchema>;

export function printUpgrade(report: UpgradeReport): string {
  const { from, to, range, uses, changes } = report;
  const head = `engines.bb ${range.before} -> ${range.after} (plugin API ${from} -> ${to})`;
  if (changes.length === 0) {
    return `${head}\nNone of the ${uses.length} members this plugin uses changed.`;
  }
  const rows = changes.map(
    ({ member, kind, change }) => `  ${kind}  ${member}: ${change}`,
  );
  const title = `Changed members this plugin uses (${changes.length}):`;
  return [head, title, ...rows].join("\n");
}

export const pluginDev = contract("plugin-dev", {
  inspect: op({
    input: z.object({
      name: z
        .string()
        .optional()
        .describe("An operation, event or slot name, or a prefix of one"),
      machine: z
        .string()
        .optional()
        .describe("A machine's host id, to list its runner parts instead"),
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
  machineParts: op({
    input: z.object({}),
    output: machinePartsSchema,
    internal: true,
  }),
  upgrade: op({
    input: z.object({
      ...located,
      to: z
        .string()
        .optional()
        .describe("The plugin API version to move to; this bb's by default"),
    }),
    output: upgradeReportSchema,
    kind: "write",
    allow: "owner",
    doors: {
      cli: {
        path: "dev upgrade",
        summary:
          "Move a plugin's engines.bb to a newer plugin API and list what it uses that changed",
        positionals: ["path"],
        print: printUpgrade,
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
  port: op({
    input: z.object(located),
    output: z.array(portFindingSchema),
    doors: {
      cli: {
        path: "dev port",
        summary:
          "List what a plugin written for the original bb uses and what each call is now",
        positionals: ["path"],
        print: printPortReport,
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
  fork: op({
    input: z.object({
      id: z.string().describe("The built-in plugin to copy"),
      path: z.string().optional().describe("Where to put the copy"),
      as: z
        .string()
        .optional()
        .describe("A new id, to run the copy beside the original"),
      cwd: located.cwd,
    }),
    output: z.object({
      id: z.string().nullable(),
      path: z.string(),
      beside: z.string().nullable(),
    }),
    kind: "write",
    allow: "owner",
    doors: {
      cli: {
        path: "dev fork",
        summary: "Copy a built-in plugin and run your copy in its place",
        positionals: ["id"],
        print: ({ id, path, beside }) =>
          beside === null
            ? `Forked ${id ?? "plugin"} to ${path}. Your copy now runs in its ` +
              "place and reloads when its files change. `bb plugin remove " +
              `${path}\` brings the original back.`
            : `Copied ${beside} to ${path} as ${id ?? "a new plugin"}. It runs ` +
              `beside ${beside} and reloads when its files change. Its ` +
              "contract, CLI and agent tool names were renamed; check " +
              "anything else it shares with the original.",
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
        summary:
          "Link bb's packages and write a tsconfig so an editor resolves them",
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
  versions: op({
    input: z.object({
      source: z.string().describe("git:<url> or npm:<package>"),
      tagPrefix: z.string().optional(),
    }),
    output: z.array(z.string()),
    allow: "owner",
  }),
  install: op({
    input: z.object({
      source: z
        .string()
        .describe(
          "git:<url>[#ref][:subdir], npm:<package>[@version] or a directory",
        ),
      version: z
        .string()
        .optional()
        .describe("A version range resolved against git tags or npm"),
      tagPrefix: z
        .string()
        .optional()
        .describe("Prefix of the git tags that carry versions, e.g. tasks/v"),
      replace: z
        .boolean()
        .optional()
        .describe("Replace a plugin already installed from the same place"),
      cwd: located.cwd,
    }),
    output: z.object({
      id: z.string().nullable(),
      path: z.string(),
      version: z.string().nullable().optional(),
      ref: z.string().nullable().optional(),
      commit: z.string().optional(),
    }),
    kind: "write",
    allow: "owner",
    doors: {
      cli: {
        path: "dev install",
        summary: "Fetch a plugin from git or npm and load it",
        positionals: ["source"],
        flags: { tagPrefix: { aliases: ["tag-prefix"] } },
        print: ({ id, path }) => `Installed ${id ?? "plugin"} at ${path}`,
      },
    },
  }),
});
