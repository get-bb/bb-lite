import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  PluginCliError,
  cliCommand,
  defineCli,
  type CliContext,
  type PluginServerApi,
} from "@bb/plugin";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import { docs } from "./contract.js";

const STATE = ".bb-docs-state.json";
const State = z.object({
  vaultId: z.string(),
  roots: z.array(z.string()),
  files: z.record(z.string(), z.string()),
});
type State = z.infer<typeof State>;

const json = { type: "boolean", description: "Print JSON" } as const;
const vault = {
  type: "string",
  placeholder: "vault-id",
  description: "Vault ID from `bb docs vaults` (default: personal)",
} as const;
const pathArg = [
  {
    name: "path",
    description: "Path relative to the vault root",
    required: true,
  },
] as const;
const dirArg = [
  {
    name: "workspace-dir",
    description: "Directory created by `bb docs pull` (default: .)",
  },
] as const;
const version = {
  type: "string",
  placeholder: "n|none",
  description: "Proposal version from `bb docs proposal` (none if null)",
  required: true,
} as const;

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const out = (stdout: string, exitCode = 0) => ({ exitCode, stdout });
const report = (asJson: boolean, value: unknown, text: string, code = 0) =>
  out(asJson ? `${JSON.stringify(value)}\n` : `${text}\n`, code);
const where = (ctx: CliContext, dir = ".") => resolve(ctx.cwd ?? ".", dir);
const parseVersion = (raw: string) => {
  if (raw === "none") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new PluginCliError(`Invalid --version: ${raw}`, { exitCode: 2 });
  return n;
};

function walk(root: string, dir = root): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(root, full);
    const rel = relative(root, full).split("\\").join("/");
    return rel === STATE ? [] : [rel];
  });
}
const loadState = (dir: string): State => {
  const file = join(dir, STATE);
  if (!fs.existsSync(file))
    throw new PluginCliError(`No ${STATE} in ${dir}; run bb docs pull first`);
  return State.parse(JSON.parse(fs.readFileSync(file, "utf8")));
};
const saveState = (dir: string, state: State) =>
  fs.writeFileSync(join(dir, STATE), `${JSON.stringify(state, null, 2)}\n`);
const inScope = (state: State, path: string) =>
  state.roots.some((r) => r === "" || path === r || path.startsWith(`${r}/`));

function changes(dir: string, state: State, withDeletes: boolean) {
  const local = walk(dir).filter((p) => inScope(state, p));
  const changed = local.flatMap((path) => {
    const known = state.files[path];
    const now = sha(fs.readFileSync(join(dir, path)));
    if (known === now) return [];
    return [{ path, status: known ? "modified" : "added" }];
  });
  const gone = Object.keys(state.files)
    .filter((p) => !local.includes(p))
    .map((path) => ({ path, status: "deleted" }));
  return [...changed, ...(withDeletes ? gone : [])];
}

export function registerDocsCli(bb: PluginServerApi): void {
  const diffOf = async (state: State, dir: string, path: string) => {
    const before = state.files[path]
      ? await bb
          .call(docs.read, { vault: state.vaultId, path })
          .then((f) => Buffer.from(f.content, f.contentEncoding).toString())
          .catch(() => "")
      : "";
    const file = join(dir, path);
    const after = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    return createTwoFilesPatch(`a/${path}`, `b/${path}`, before, after);
  };

  async function pull(dir: string, vaultId: string, roots: string[]) {
    fs.mkdirSync(dir, { recursive: true });
    const old = fs.existsSync(join(dir, STATE)) ? loadState(dir) : null;
    const state: State = { vaultId, roots, files: { ...old?.files } };
    const all = await bb.call(docs.list, { vault: vaultId });
    const files = all
      .filter((e) => e.kind === "file" && inScope(state, e.path))
      .map((e) => e.path);
    for (const path of files) {
      const remote = await bb.call(docs.read, { vault: vaultId, path });
      const target = join(dir, path);
      const local = fs.existsSync(target) ? sha(fs.readFileSync(target)) : null;
      const known = state.files[path];
      if (
        local &&
        local !== known &&
        local !== remote.sha256 &&
        known !== remote.sha256
      )
        throw new PluginCliError(
          `Conflict: ${path} changed both locally and in the vault`,
        );
      if (local && local !== known && known === remote.sha256) continue;
      fs.mkdirSync(dirname(target), { recursive: true });
      fs.writeFileSync(
        target,
        Buffer.from(remote.content, remote.contentEncoding),
      );
      state.files[path] = remote.sha256;
    }
    for (const path of Object.keys(state.files))
      if (inScope(state, path) && !files.includes(path)) {
        fs.rmSync(join(dir, path), { force: true });
        delete state.files[path];
      }
    saveState(dir, state);
    return files;
  }

  bb.cli.register(
    defineCli({
      name: "docs",
      summary: "Read, edit, and propose changes to Docs vault documents",
      commands: {
        propose: cliCommand({
          summary: "Propose a complete candidate for approval",
          positionals: pathArg,
          options: {
            vault,
            json,
            file: {
              type: "string",
              placeholder: "path",
              description:
                "Workspace file with the complete candidate Markdown",
              required: true,
            },
            "expected-sha256": {
              type: "string",
              placeholder: "hash",
              description: "Current document SHA-256 from read --json",
              required: true,
            },
            version,
          },
          async run({ options: o, positionals }, ctx) {
            const proposal = await bb.call(docs.propose, {
              vault: o.vault,
              path: positionals.path,
              content: fs.readFileSync(where(ctx, o.file), "utf8"),
              expectedSha256: o["expected-sha256"],
              expectedVersion: parseVersion(o.version),
            });
            const text = `Proposed ${proposal.path} (version ${proposal.version})`;
            return report(o.json, proposal, text);
          },
        }),
        "proposal-update": cliCommand({
          summary: "Edit a pending candidate using its version",
          positionals: pathArg,
          options: {
            vault,
            json,
            version,
            content: {
              type: "string",
              description: "Complete candidate Markdown",
              required: true,
            },
          },
          async run({ options: o, positionals }) {
            const expectedVersion = parseVersion(o.version);
            if (expectedVersion === null)
              throw new PluginCliError(
                "This action requires a proposal version.",
              );
            const proposal = await bb.call(docs.updateProposal, {
              vault: o.vault,
              path: positionals.path,
              content: o.content,
              expectedVersion,
            });
            const text = `Updated ${proposal.path} (version ${proposal.version})`;
            return report(o.json, proposal, text);
          },
        }),
        pull: cliCommand({
          summary: "Copy vault documents into a workspace directory",
          positionals: [
            { name: "path", description: "Document or folder in the vault" },
          ],
          options: {
            vault,
            json,
            into: {
              type: "string",
              placeholder: "dir",
              description: "Workspace directory to pull into",
              required: true,
            },
            all: {
              type: "boolean",
              description: "Pull the whole vault instead of one path",
            },
            folder: {
              type: "boolean",
              description: "Treat the path as a folder subtree",
            },
          },
          async run({ options: o, positionals }, ctx) {
            if (o.all === (positionals.path !== undefined))
              throw new PluginCliError("Pass a path or --all", { exitCode: 2 });
            const root = positionals.path?.replace(/\/$/u, "") ?? "";
            const files = await pull(
              where(ctx, o.into),
              o.vault ?? "personal",
              [root],
            );
            if (!o.folder && !o.all && !files.includes(root))
              throw new PluginCliError(`No document at ${root}`);
            return report(o.json, { files }, `Pulled ${files.length} file(s)`);
          },
        }),
        status: cliCommand({
          summary: "Show local changes since pull (exit 4 when changed)",
          positionals: dirArg,
          options: {
            json,
            diff: { type: "boolean", description: "Show diffs" },
          },
          async run({ options: o, positionals }, ctx) {
            const dir = where(ctx, positionals["workspace-dir"]);
            const state = loadState(dir);
            const list = changes(dir, state, true);
            const diffs = o.diff
              ? await Promise.all(list.map((c) => diffOf(state, dir, c.path)))
              : [];
            const text = list.length
              ? [...list.map((c) => `${c.status}\t${c.path}`), ...diffs].join(
                  "\n",
                )
              : "No changes";
            return report(o.json, { changes: list }, text, list.length ? 4 : 0);
          },
        }),
        push: cliCommand({
          summary: "Write local changes back to the vault with version checks",
          positionals: dirArg,
          options: {
            json,
            diff: { type: "boolean", description: "Show diffs" },
            "dry-run": {
              type: "boolean",
              description: "Plan the push without writing to the vault",
            },
            delete: {
              type: "boolean",
              description: "Also delete vault paths deleted locally",
            },
          },
          async run({ options: o, positionals }, ctx) {
            const dir = where(ctx, positionals["workspace-dir"]);
            const state = loadState(dir);
            const list = changes(dir, state, o.delete);
            const diffs = o.diff
              ? await Promise.all(list.map((c) => diffOf(state, dir, c.path)))
              : [];
            if (!o["dry-run"])
              for (const { path, status } of list) {
                const expected = state.files[path] ?? null;
                if (status === "deleted") {
                  await bb.call(docs.remove, { vault: state.vaultId, path });
                  delete state.files[path];
                  continue;
                }
                const bytes = fs.readFileSync(join(dir, path));
                const { sha256 } = await bb.call(docs.write, {
                  vault: state.vaultId,
                  path,
                  content: bytes.toString("base64"),
                  contentEncoding: "base64",
                  expectedSha256: expected,
                });
                state.files[path] = sha256;
                saveState(dir, state);
              }
            saveState(dir, state);
            const verb = o["dry-run"] ? "Would push" : "Pushed";
            const text = [
              `${verb} ${list.length} change(s)`,
              ...list.map((c) => `${c.status}\t${c.path}`),
              ...diffs,
            ];
            return report(
              o.json,
              { changes: list, dryRun: o["dry-run"] },
              text.join("\n"),
            );
          },
        }),
      },
    }),
  );
}
