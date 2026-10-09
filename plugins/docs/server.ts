import { posix } from "node:path";
import { homedir } from "node:os";
import { fail, sessions, type PluginServerApi } from "@bb/plugin";
import { machineFiles, type PathMutation } from "@bb/runner";
import { registerDocsCli } from "./cli.js";
import { registerDocsExtras } from "./extras.js";
import { onHost, registerDocsSync } from "./sync.js";
import {
  docs,
  Proposal,
  type DocFile,
  type Entry,
  type Vault,
} from "./contract.js";

const ok = { ok: true } as const;

export function vaultPath(raw: string): string {
  const clean = posix.normalize(raw.replaceAll("\\", "/")).replace(/\/$/u, "");
  if (!clean || clean === "." || clean.startsWith("../") || clean === "..")
    fail("invalid", `Invalid vault path: ${raw}`);
  if (clean.startsWith("/")) fail("invalid", `Path must be relative: ${raw}`);
  return clean;
}

export default function docsServer(bb: PluginServerApi): void {
  const { tables } = bb.storage;
  const vaults = tables.name("vaults");
  const proposals = tables.name("proposals");
  const entryOrder = tables.name("entry_order");
  tables.migrate([
    `CREATE TABLE ${vaults} (vault_id TEXT PRIMARY KEY, name TEXT NOT NULL, host_id TEXT, root_path TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE ${proposals} (vault_id TEXT NOT NULL, path TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (vault_id, path))`,
    `CREATE TABLE ${entryOrder} (vault_id TEXT NOT NULL, folder TEXT NOT NULL, names TEXT NOT NULL, PRIMARY KEY (vault_id, folder))`,
  ]);
  tables.publish(docs.vaultRows, "vaults");
  if (!bb.db.get(`SELECT 1 AS one FROM ${vaults}`))
    bb.db.run(
      `INSERT INTO ${vaults} VALUES ('personal', 'Personal', NULL, ?, ?)`,
      posix.join(homedir(), "Notes"),
      bb.now(),
    );

  const allVaults = () =>
    bb.db.all<Vault>(`SELECT * FROM ${vaults} ORDER BY created_at`);
  const getVault = (vaultId = "personal"): Vault => {
    const found = allVaults().find((v) => v.vaultId === vaultId);
    if (!found)
      fail("not_found", `Unknown vault: ${vaultId}`, {
        reason: "unknown_vault",
        hint: "List vaults with `bb docs vaults`",
      });
    return found;
  };
  const host = (vault: Vault) => {
    const hostId = vault.hostId ?? bb.runners.localHostId;
    return { call: onHost(bb, hostId) };
  };
  const at = (vaultId: string | undefined, raw: string) => {
    const vault = getVault(vaultId);
    const path = vaultPath(raw);
    const runner = host(vault);
    const where = {
      path: posix.join(vault.rootPath, path),
      rootPath: vault.rootPath,
    };
    return { vault, path, runner, where };
  };

  const read = async (vaultId: string | undefined, raw: string) => {
    const { vault, path, runner, where } = at(vaultId, raw);
    const file = await runner.call(machineFiles.read, where);
    const { content, contentEncoding, sha256, sizeBytes } = file;
    const vid = vault.vaultId;
    return { vaultId: vid, path, content, contentEncoding, sha256, sizeBytes };
  };
  const tryRead = (vaultId: string, path: string): Promise<DocFile | null> =>
    read(vaultId, path).catch(() => null);
  const write = async (input: {
    vault?: string;
    path: string;
    content: string;
    expectedSha256?: string | null;
    contentEncoding?: "utf8" | "base64";
  }) => {
    const { path, runner, where } = at(input.vault, input.path);
    const result = await runner.call(machineFiles.write, {
      ...where,
      content: input.content,
      contentEncoding: input.contentEncoding ?? "utf8",
      createParents: true,
      ...(input.expectedSha256 === undefined
        ? {}
        : { expectedSha256: input.expectedSha256 }),
    });
    if (result.outcome === "conflict")
      fail(
        "conflict",
        `Conflict: ${path} changed in the vault (now ${result.currentSha256 ?? "missing"})`,
        {
          reason: "document_changed",
          hint: "Read the document again and reapply your change",
        },
      );
    bb.changed(docs.list);
    bb.changed(docs.read);
    return { path, sha256: result.sha256 };
  };

  const getProposal = (vaultId: string, path: string) => {
    const row = bb.db.get<{ data: string }>(
      `SELECT data FROM ${proposals} WHERE vault_id = ? AND path = ?`,
      vaultId,
      path,
    );
    return row ? Proposal.parse(JSON.parse(row.data)) : null;
  };
  const saveProposal = (proposal: Proposal) => {
    bb.db.run(
      `INSERT OR REPLACE INTO ${proposals} VALUES (?, ?, ?)`,
      proposal.vaultId,
      proposal.path,
      JSON.stringify(proposal),
    );
    bb.changed(docs.proposal);
    return proposal;
  };
  const current = (vaultId: string | undefined, raw: string, v: number) => {
    const { vault, path } = at(vaultId, raw);
    const proposal = getProposal(vault.vaultId, path);
    if (!proposal) fail("not_found", `No proposal for ${path}`);
    if (proposal.version !== v)
      fail(
        "conflict",
        `Conflict: proposal is at version ${proposal.version}, not ${v}`,
        { reason: "proposal_version", hint: "Run `bb docs proposal <path>`" },
      );
    return proposal;
  };

  bb.implement(docs.vaults, allVaults);
  bb.implement(docs.createVault, ({ name, absoluteRoot, hostId }) => {
    if (!posix.isAbsolute(absoluteRoot))
      fail("invalid", "The vault root must be an absolute path");
    const base = name.toLowerCase().replace(/[^a-z0-9]+/gu, "-") || "vault";
    const taken = new Set(allVaults().map((v) => v.vaultId));
    let vaultId = base;
    for (let n = 2; taken.has(vaultId); n += 1) vaultId = `${base}-${n}`;
    const root = posix.normalize(absoluteRoot);
    const row = [vaultId, name, hostId ?? null, root, bb.now()] as const;
    bb.db.run(`INSERT INTO ${vaults} VALUES (?, ?, ?, ?, ?)`, ...row);
    bb.changed(docs.vaults);
    return getVault(vaultId);
  });
  bb.implement(docs.deleteVault, ({ vaultId }) => {
    getVault(vaultId);
    bb.db.run(`DELETE FROM ${vaults} WHERE vault_id = ?`, vaultId);
    bb.db.run(`DELETE FROM ${proposals} WHERE vault_id = ?`, vaultId);
    bb.changed(docs.vaults);
    return ok;
  });
  bb.implement(docs.list, async ({ vault }) => {
    const found = getVault(vault);
    const runner = host(found);
    const { paths } = await runner.call(machineFiles.list, {
      rootPath: found.rootPath,
      includeFiles: true,
      includeDirectories: true,
      includeHidden: false,
      fresh: true,
      limit: 5000,
    });
    const kinds = new Map<string, Entry["kind"]>();
    for (const { path, kind } of paths) {
      const clean = path.replace(/\/$/u, "");
      kinds.set(clean, kind);
      for (let d = posix.dirname(clean); d !== "."; d = posix.dirname(d))
        kinds.set(d, "directory");
    }
    return [...kinds]
      .map(([path, kind]) => ({ path, kind }))
      .sort((a, b) => a.path.localeCompare(b.path));
  });
  const watch = registerDocsExtras(bb, entryOrder, read);
  bb.implement(docs.read, async ({ vault, path }) => {
    const file = await read(vault, path);
    watch({ vault: file.vaultId, path: file.path }, file.sha256);
    return file;
  });
  bb.implement(docs.write, write);
  const mutate = async (
    vault: string | undefined,
    raw: string,
    op: (where: { path: string; rootPath: string }) => PathMutation,
  ) => {
    const { runner, where } = at(vault, raw);
    await runner.call(machineFiles.mutate, op(where));
    bb.changed(docs.list);
    return ok;
  };
  bb.implement(docs.mkdir, ({ vault, path }) =>
    mutate(vault, path, (w) => ({ ...w, op: "mkdir", recursive: true })),
  );
  bb.implement(docs.remove, ({ vault, path, recursive }) =>
    mutate(vault, path, (w) => ({ ...w, op: "remove", recursive })),
  );
  bb.implement(docs.move, ({ vault, from, to }) => {
    const destinationPath = at(vault, to).where.path;
    return mutate(vault, from, ({ path, rootPath }) => {
      const sourcePath = path;
      return { op: "move", sourcePath, destinationPath, rootPath };
    });
  });

  bb.implement(docs.proposal, ({ vault, path }) => {
    const found = at(vault, path);
    return getProposal(found.vault.vaultId, found.path);
  });
  bb.implement(docs.propose, async (input) => {
    const { vault, path } = at(input.vault, input.path);
    const existing = getProposal(vault.vaultId, path);
    if ((existing?.version ?? null) !== input.expectedVersion)
      fail(
        "conflict",
        `Conflict: proposal version is ${existing?.version ?? "none"}`,
        { reason: "proposal_version", hint: "Run `bb docs proposal <path>`" },
      );
    const file = await read(vault.vaultId, path);
    if (file.sha256 !== input.expectedSha256)
      fail("conflict", `Conflict: ${path} changed since it was read`, {
        reason: "document_changed",
        hint: "Read the document again with `bb docs read --json`",
      });
    return saveProposal({
      vaultId: vault.vaultId,
      path,
      version: (existing?.version ?? 0) + 1,
      baseContent: file.content,
      baseSha256: file.sha256,
      content: input.content,
      status: "pending",
      resolvedSha256: null,
    });
  });
  bb.implement(docs.updateProposal, (input) => {
    const proposal = current(input.vault, input.path, input.expectedVersion);
    if (proposal.status !== "pending")
      fail("conflict", "Only a pending proposal can be edited", {
        reason: "proposal_resolved",
      });
    const { content } = input;
    return saveProposal({
      ...proposal,
      content,
      version: proposal.version + 1,
    });
  });
  bb.implement(docs.resolveProposal, async (input) => {
    const p = current(input.vault, input.path, input.expectedVersion);
    const next = { ...p, version: p.version + 1 };
    const put = (content: string, expectedSha256: string | null) =>
      write({ vault: p.vaultId, path: p.path, content, expectedSha256 });
    const need = (status: Proposal["status"]) => {
      if (p.status !== status)
        fail("conflict", `Cannot ${input.action} a ${p.status} proposal`, {
          reason: "proposal_state",
        });
    };
    if (input.action === "reject") {
      need("pending");
      return saveProposal({ ...next, status: "rejected" });
    }
    if (input.action === "undo") {
      need("accepted");
      await put(p.baseContent, p.resolvedSha256);
      return saveProposal({ ...next, status: "undone" });
    }
    need(input.action === "accept" ? "pending" : "undone");
    const base = input.action === "accept" ? p.baseSha256 : null;
    const now =
      input.action === "redo" ? await tryRead(p.vaultId, p.path) : null;
    const { sha256 } = await put(p.content, base ?? now?.sha256 ?? null);
    return saveProposal({
      ...next,
      status: "accepted",
      resolvedSha256: sha256,
    });
  });

  bb.add(sessions.mention, {
    id: "docs",
    label: "Docs",
    async search({ query }) {
      const needle = query.toLowerCase();
      const hits = [];
      for (const vault of allVaults()) {
        const entries = await bb
          .call(docs.list, { vault: vault.vaultId })
          .catch(() => []);
        for (const { path, kind } of entries)
          if (kind === "file" && path.toLowerCase().includes(needle))
            hits.push({
              id: JSON.stringify([vault.vaultId, path]),
              title: posix.basename(path),
              subtitle: `${vault.name}/${path}`,
              icon: "FileText",
            });
      }
      return hits.slice(0, 20);
    },
    async resolve(itemId) {
      const [vaultId, path] = JSON.parse(itemId) as [string, string];
      const file = await read(vaultId, path);
      const proposal = getProposal(vaultId, file.path);
      const meta = `sha256: ${file.sha256}\nproposal: ${proposal ? `version ${proposal.version} (${proposal.status})` : "none"}`;
      return {
        context: `Docs document (${vaultId}/${path})\n${meta}\n\n${file.content}`,
      };
    },
  });

  registerDocsCli(bb);
  registerDocsSync(bb);
}
