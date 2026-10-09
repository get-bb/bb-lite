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
  vaultRows: table<Vault>(),
});
