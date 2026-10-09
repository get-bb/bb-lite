import { posix } from "node:path";
import { fail, files, type PluginServerApi } from "@bb/plugin";
import { docs } from "./contract.js";

const ok = { ok: true } as const;
const RECENT_LIMIT = 10;
const WATCH_MS = 1500;
const WATCH_WINDOW_MS = 10 * 60 * 1000;

type Ref = { vault: string; path: string };

export const slugTitle = (content: string) => {
  const heading = /^#\s+(.+)$/mu.exec(content)?.[1]?.trim() ?? "";
  return heading
    .replace(/[\\/:*?"<>|#]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
};

type Reader = (vault: string, path: string) => Promise<{ sha256: string }>;

export function registerDocsExtras(
  bb: PluginServerApi,
  order: string,
  read: Reader,
) {
  bb.implement(docs.openFile, (input) => bb.call(files.read, input));
  bb.implement(docs.saveOpenedFile, async (input) => {
    const result = await bb.call(files.write, input);
    if (result.outcome === "conflict")
      fail("conflict", `${input.path} changed since it was opened`, {
        reason: "document_changed",
        hint: "Reload the file and reapply your change",
      });
    return { sha256: result.sha256 };
  });

  const recentKey = (threadId: string) => `recent:${threadId}`;
  const recentOf = async (threadId: string) =>
    (await bb.storage.kv.get<Ref[]>(recentKey(threadId))) ?? [];
  bb.implement(docs.recent, ({ threadId }) => recentOf(threadId));
  bb.implement(docs.visit, async ({ threadId, vault, path }) => {
    const rest = (await recentOf(threadId)).filter(
      (r) => r.vault !== vault || r.path !== path,
    );
    const next = [{ vault, path }, ...rest].slice(0, RECENT_LIMIT);
    await bb.storage.kv.set(recentKey(threadId), next);
    bb.changed(docs.recent);
    return ok;
  });

  bb.implement(docs.order, ({ vault = "personal", folder }) =>
    bb.db
      .all<{ names: string }>(
        `SELECT names FROM ${order} WHERE vault_id = ? AND folder = ?`,
        vault,
        folder,
      )
      .flatMap((row) => JSON.parse(row.names) as string[]),
  );
  bb.implement(docs.reorder, ({ vault = "personal", folder, names }) => {
    bb.db.run(
      `INSERT OR REPLACE INTO ${order} VALUES (?, ?, ?)`,
      vault,
      folder,
      JSON.stringify(names),
    );
    bb.changed(docs.order);
    return ok;
  });

  bb.implement(docs.renameToTitle, async ({ vault, path }) => {
    const file = await bb.call(docs.read, { vault, path });
    const title = slugTitle(
      Buffer.from(file.content, file.contentEncoding).toString(),
    );
    if (!title)
      fail("invalid", `${path} has no "# Title" heading`, {
        reason: "no_title",
      });
    const dir = posix.dirname(file.path);
    const to = posix.join(dir === "." ? "" : dir, `${title}.md`);
    if (to === file.path) return { path: to };
    const taken = await bb
      .call(docs.read, { vault, path: to })
      .then(() => true)
      .catch(() => false);
    if (taken)
      fail("conflict", `${to} already exists`, { reason: "path_taken" });
    await bb.call(docs.move, { vault, from: file.path, to });
    return { path: to };
  });

  bb.implement(docs.uploadAttachment, async (input) => {
    const name = posix.basename(input.name.replaceAll("\\", "/"));
    const dir = posix.dirname(input.path);
    const relative = `attachments/${name}`;
    const target = posix.join(dir === "." ? "" : dir, relative);
    await bb.call(docs.write, {
      vault: input.vault,
      path: target,
      content: input.contentBase64,
      contentEncoding: "base64",
    });
    const image = /\.(png|jpe?g|gif|webp|svg)$/iu.test(name);
    const link = `[${name}](${encodeURI(relative)})`;
    return { path: target, markdown: image ? `!${link}` : link };
  });

  const watched = new Map<string, { ref: Ref; sha256: string; at: number }>();
  const listings = new Map<string, string>();
  const poll = async () => {
    let listChanged = false;
    for (const vault of await bb.call(docs.vaults, {})) {
      const paths = await bb
        .call(docs.list, { vault: vault.vaultId })
        .then((list) => list.map((e) => e.path).join("\n"))
        .catch(() => "");
      if (listings.has(vault.vaultId) && listings.get(vault.vaultId) !== paths)
        listChanged = true;
      listings.set(vault.vaultId, paths);
    }
    if (listChanged) bb.changed(docs.list);
    for (const [key, seen] of watched) {
      if (Date.now() - seen.at > WATCH_WINDOW_MS) {
        watched.delete(key);
        continue;
      }
      const now = await read(seen.ref.vault, seen.ref.path).catch(() => null);
      if (now?.sha256 === seen.sha256) continue;
      seen.sha256 = now?.sha256 ?? "";
      bb.changed(docs.read);
    }
  };
  bb.background.service("watch-vaults", {
    async start(signal) {
      while (!signal.aborted) {
        await poll().catch(() => undefined);
        await new Promise((done) => setTimeout(done, WATCH_MS));
      }
    },
  });
  return (ref: Ref, sha256: string) =>
    watched.set(JSON.stringify(ref), { ref, sha256, at: Date.now() });
}
