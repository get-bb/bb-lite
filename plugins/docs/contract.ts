import { contract, op, table } from "@bb/plugin";
import { z } from "zod";

export const Vault = z.object({
  vaultId: z.string(),
  name: z.string(),
  hostId: z.string().nullable(),
  rootPath: z.string(),
  createdAt: z.number(),
});
export type Vault = z.infer<typeof Vault>;

export const Proposal = z.object({
  vaultId: z.string(),
  path: z.string(),
  version: z.number().int().positive(),
  baseContent: z.string(),
  baseSha256: z.string(),
  content: z.string(),
  status: z.enum(["pending", "accepted", "rejected", "undone"]),
  resolvedSha256: z.string().nullable(),
});
export type Proposal = z.infer<typeof Proposal>;

export const Entry = z.object({
  path: z.string(),
  kind: z.enum(["file", "directory"]),
});
export type Entry = z.infer<typeof Entry>;

export const DocFile = z.object({
  vaultId: z.string(),
  path: z.string(),
  content: z.string(),
  contentEncoding: z.enum(["utf8", "base64"]),
  sha256: z.string(),
  sizeBytes: z.number(),
});
export type DocFile = z.infer<typeof DocFile>;

const vault = z
  .string()
  .optional()
  .describe("Vault ID from `bb docs vaults` (default: personal)");
const path = z.string().describe("Path relative to the vault root");
const at = { vault, path };
const version = z.number().int().positive();
const lines = (rows: string[]) => `${rows.join("\n")}\n`;
const caller = {
  cwd: z.string().optional(),
  hostId: z.string().optional(),
};
const from = { cwd: "cwd", hostId: "hostId" } as const;
const workspaceDir = z
  .string()
  .optional()
  .describe("Directory created by `bb docs pull` (default: .)");
const showDiff = z.boolean().optional().describe("Show diffs");
export const Change = z.object({
  path: z.string(),
  status: z.enum(["added", "modified", "deleted"]),
});
export type Change = z.infer<typeof Change>;
export const Conflict = z.object({ path: z.string(), reason: z.string() });
export type Conflict = z.infer<typeof Conflict>;
const changeLines = (changes: Change[]) =>
  changes.map((c) => `${c.status}\t${c.path}`);
const conflictLines = (conflicts: Conflict[]) =>
  conflicts.map((c) => `conflict\t${c.path}\t${c.reason}`);

export const docs = contract("docs", {
  vaults: op({
    input: z.object({}),
    output: z.array(Vault),
    doors: {
      cli: {
        path: "docs vaults",
        summary: "List vaults",
        print: (list) =>
          lines(list.map((v) => `${v.vaultId}\t${v.name}\t${v.rootPath}`)),
      },
    },
  }),
  createVault: op({
    input: z.object({
      name: z.string().min(1).describe("Display name for the vault"),
      absoluteRoot: z.string().min(1).describe("Absolute folder on the host"),
      hostId: z.string().optional().describe("Host id (default: this server)"),
    }),
    output: Vault,
    kind: "write",
    doors: {
      cli: {
        path: "docs vault-add",
        summary: "Add a vault",
        positionals: ["name", "absoluteRoot", "hostId"],
      },
    },
  }),
  deleteVault: op({
    input: z.object({ vaultId: z.string().describe("Vault ID") }),
    output: z.object({ ok: z.literal(true) }),
    kind: "write",
    doors: {
      cli: {
        path: "docs vault-remove",
        summary: "Remove a vault (files stay on disk)",
        positionals: ["vaultId"],
      },
    },
  }),
  list: op({
    input: z.object({ vault }),
    output: z.array(Entry),
    doors: {
      cli: {
        path: "docs list",
        summary: "List documents and folders in a vault",
        print: (list) => lines(list.map((e) => `${e.kind}\t${e.path}`)),
      },
    },
  }),
  read: op({
    input: z.object(at),
    output: DocFile,
    doors: {
      cli: {
        path: "docs read",
        summary: "Print a document",
        positionals: ["path"],
        print: (file) => file.content,
      },
    },
  }),
  write: op({
    input: z.object({
      ...at,
      content: z.string().describe("Complete UTF-8 file contents"),
      expectedSha256: z.string().nullable().optional(),
      contentEncoding: z.enum(["utf8", "base64"]).optional(),
    }),
    output: z.object({ path: z.string(), sha256: z.string() }),
    kind: "write",
    doors: {
      cli: {
        path: "docs write",
        summary: "Deprecated: write a document directly",
        positionals: ["path"],
      },
    },
  }),
  mkdir: op({
    input: z.object(at),
    output: z.object({ ok: z.literal(true) }),
    kind: "write",
    doors: {
      cli: {
        path: "docs mkdir",
        summary: "Deprecated: create a folder",
        positionals: ["path"],
      },
    },
  }),
  move: op({
    input: z.object({
      vault,
      from: z.string().describe("Existing path relative to the vault root"),
      to: z.string().describe("Destination path relative to the vault root"),
    }),
    output: z.object({ ok: z.literal(true) }),
    kind: "write",
    doors: {
      cli: {
        path: "docs move",
        summary: "Deprecated: move or rename a path",
        positionals: ["from", "to"],
      },
    },
  }),
  remove: op({
    input: z.object({
      ...at,
      recursive: z
        .boolean()
        .optional()
        .describe("Remove a directory and everything inside it"),
    }),
    output: z.object({ ok: z.literal(true) }),
    kind: "write",
    doors: {
      cli: {
        path: "docs remove",
        summary: "Deprecated: remove a path",
        positionals: ["path"],
      },
    },
  }),
  proposal: op({
    input: z.object(at),
    output: Proposal.nullable(),
    doors: {
      cli: {
        path: "docs proposal",
        summary: "Show the latest proposal for a document",
        positionals: ["path"],
      },
    },
  }),
  propose: op({
    input: z.object({
      ...at,
      content: z.string(),
      expectedSha256: z.string().min(1),
      expectedVersion: version.nullable(),
    }),
    output: Proposal,
    kind: "write",
  }),
  updateProposal: op({
    input: z.object({ ...at, content: z.string(), expectedVersion: version }),
    output: Proposal,
    kind: "write",
  }),
  resolveProposal: op({
    input: z.object({
      ...at,
      action: z.enum(["accept", "reject", "undo", "redo"]),
      expectedVersion: version,
    }),
    output: Proposal,
    kind: "write",
  }),
  pull: op({
    input: z.object({
      vault,
      path: z.string().optional().describe("Document or folder in the vault"),
      into: z.string().describe("Workspace directory to pull into"),
      all: z
        .boolean()
        .optional()
        .describe("Pull the whole vault instead of one path"),
      folder: z
        .boolean()
        .optional()
        .describe("Treat the path as a folder subtree"),
      ...caller,
    }),
    output: z.object({ files: z.array(z.string()) }),
    kind: "write",
    doors: {
      cli: {
        path: "docs pull",
        summary: "Copy vault documents into a workspace directory",
        positionals: ["path"],
        flags: { into: { placeholder: "dir" } },
        from,
        constraints: [{ kind: "exactly-one", options: ["path", "all"] }],
        print: ({ files }) => `Pulled ${files.length} file(s)\n`,
      },
    },
  }),
  status: op({
    input: z.object({ workspaceDir, diff: showDiff, ...caller }),
    output: z.object({
      outcome: z.enum(["planned", "conflict"]),
      changes: z.array(Change),
      conflicts: z.array(Conflict),
      diffs: z.array(z.string()).optional(),
    }),
    doors: {
      cli: {
        path: "docs status",
        summary:
          "Show local changes since pull (exit 4 when changed, 3 on conflict)",
        positionals: ["workspaceDir"],
        from,
        print: ({ changes, conflicts, diffs = [] }) =>
          changes.length || conflicts.length
            ? lines([
                ...conflictLines(conflicts),
                ...changeLines(changes),
                ...diffs,
              ])
            : "No changes\n",
        exitCode: ({ changes, conflicts }) =>
          conflicts.length ? 3 : changes.length ? 4 : 0,
      },
    },
  }),
  push: op({
    input: z.object({
      workspaceDir,
      diff: showDiff,
      dryRun: z
        .boolean()
        .optional()
        .describe("Plan the push without writing to the vault"),
      delete: z
        .boolean()
        .optional()
        .describe("Also delete vault paths deleted locally"),
      ...caller,
    }),
    output: z.object({
      outcome: z.enum(["planned", "pushed", "conflict"]),
      changes: z.array(Change),
      conflicts: z.array(Conflict),
      dryRun: z.boolean().optional(),
      diffs: z.array(z.string()).optional(),
    }),
    kind: "write",
    doors: {
      cli: {
        path: "docs push",
        summary:
          "Write local changes back to the vault (exit 3 on conflict, nothing written)",
        positionals: ["workspaceDir"],
        from,
        print: ({ outcome, changes, conflicts, diffs = [] }) =>
          outcome === "conflict"
            ? lines([
                ...conflictLines(conflicts),
                "No push changes were made; pull and merge the conflicts first.",
              ])
            : lines([
                `${outcome === "planned" ? "Would push" : "Pushed"} ${changes.length} change(s)`,
                ...changeLines(changes),
                ...diffs,
              ]),
        exitCode: ({ outcome }) => (outcome === "conflict" ? 3 : 0),
      },
    },
  }),
  openFile: op({
    input: z.object({
      threadId: z.string(),
      path: z.string(),
      source: z.enum(["workspace", "thread-storage", "host"]).optional(),
    }),
    output: z.object({ content: z.string(), sha256: z.string() }).nullable(),
  }),
  saveOpenedFile: op({
    input: z.object({
      threadId: z.string(),
      path: z.string(),
      content: z.string(),
      expectedSha256: z.string().nullable(),
      source: z.enum(["workspace", "thread-storage", "host"]).optional(),
    }),
    output: z.object({ sha256: z.string() }),
    kind: "write",
  }),
  recent: op({
    input: z.object({ threadId: z.string() }),
    output: z.array(z.object({ vault: z.string(), path: z.string() })),
  }),
  visit: op({
    input: z.object({ threadId: z.string(), vault: z.string(), path }),
    output: z.object({ ok: z.literal(true) }),
    kind: "write",
  }),
  order: op({
    input: z.object({ vault, folder: z.string() }),
    output: z.array(z.string()),
  }),
  reorder: op({
    input: z.object({ vault, folder: z.string(), names: z.array(z.string()) }),
    output: z.object({ ok: z.literal(true) }),
    kind: "write",
  }),
  renameToTitle: op({
    input: z.object(at),
    output: z.object({ path: z.string() }),
    kind: "write",
  }),
  uploadAttachment: op({
    input: z.object({
      ...at,
      name: z.string().min(1),
      contentBase64: z.string(),
    }),
    output: z.object({ path: z.string(), markdown: z.string() }),
    kind: "write",
  }),
  vaultRows: table<Vault>(),
});
