import { createHash } from "node:crypto";
import { posix } from "node:path";
import { fail, type Op, type PluginServerApi } from "@bb/plugin";
import { machineFiles } from "@bb/runner";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import { docs, type Change } from "./contract.js";

const STATE = ".bb-docs-state.json";
const State = z.object({
  vaultId: z.string(),
  roots: z.array(z.string()),
  files: z.record(z.string(), z.string()),
});
type State = z.infer<typeof State>;
type Change = z.infer<typeof Change>;
type Caller = { cwd?: string; hostId?: string };
type Local = { path: string; modifiedAt: number | undefined };

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const inScope = (state: State, path: string) =>
  state.roots.some((r) => r === "" || path === r || path.startsWith(`${r}/`));

export const onHost =
  (bb: PluginServerApi, hostId: string) =>
  <O extends Op>(op: O, input: z.input<O["input"]>) =>
    bb.runners.call(hostId, op, input);

export function registerDocsSync(bb: PluginServerApi): void {
  const hashes = new Map<string, { modifiedAt: number; sha256: string }>();
  const machine = (caller: Caller, dir = ".") => {
    const hostId = caller.hostId ?? bb.runners.localHostId;
    const base = posix.resolve(caller.cwd ?? ".", dir);
    const call = onHost(bb, hostId);
    const at = (path: string) => posix.join(base, path);
    const bytes = (path: string) =>
      call(machineFiles.read, { path: at(path) })
        .then((f) => Buffer.from(f.content, f.contentEncoding))
        .catch(() => null);
    const put = (path: string, content: Buffer) =>
      call(machineFiles.write, {
        path: at(path),
        content: content.toString("base64"),
        contentEncoding: "base64",
        createParents: true,
      });
    const remove = (path: string) =>
      call(machineFiles.mutate, { op: "remove", path: at(path) }).catch(
        () => null,
      );
    const walk = async (dir = base, prefix = ""): Promise<Local[]> => {
      const listing = await call(machineFiles.browse, { path: dir }).catch(
        () => ({ entries: [] }),
      );
      const nested = await Promise.all(
        listing.entries.map((e) =>
          e.kind === "directory"
            ? walk(e.path, `${prefix}${e.name}/`)
            : [{ path: `${prefix}${e.name}`, modifiedAt: e.modifiedAt }],
        ),
      );
      return nested.flat();
    };
    const hashOf = async ({ path, modifiedAt }: Local) => {
      const key = `${hostId}:${at(path)}`;
      const seen = hashes.get(key);
      if (seen && modifiedAt !== undefined && seen.modifiedAt === modifiedAt)
        return seen.sha256;
      const now = await bytes(path);
      if (!now) return null;
      const sha256 = sha(now);
      if (modifiedAt !== undefined) hashes.set(key, { modifiedAt, sha256 });
      return sha256;
    };
    const loadState = async () => {
      const raw = await bytes(STATE);
      if (!raw)
        fail("not_found", `No ${STATE} in ${base}; run bb docs pull first`, {
          reason: "no_pull_state",
          hint: "Run `bb docs pull <path> --into <dir>` first",
        });
      return State.parse(JSON.parse(raw.toString("utf8")));
    };
    const saveState = (state: State) =>
      put(STATE, Buffer.from(`${JSON.stringify(state, null, 2)}\n`));
    return { base, bytes, put, remove, walk, hashOf, loadState, saveState };
  };
  type Machine = ReturnType<typeof machine>;

  const remoteText = (vault: string, path: string) =>
    bb
      .call(docs.read, { vault, path })
      .then((f) => Buffer.from(f.content, f.contentEncoding).toString())
      .catch(() => "");

  async function changes(m: Machine, state: State, withDeletes: boolean) {
    const found = (await m.walk()).filter((f) => inScope(state, f.path));
    const local = new Set(found.map((f) => f.path));
    const changed: Change[] = [];
    for (const file of found) {
      const known = state.files[file.path];
      const now = await m.hashOf(file);
      if (now && known !== now)
        changed.push({ path: file.path, status: known ? "modified" : "added" });
    }
    const gone = Object.keys(state.files)
      .filter((p) => !local.has(p))
      .map((path): Change => ({ path, status: "deleted" }));
    return [...changed, ...(withDeletes ? gone : [])];
  }
  const diffs = (m: Machine, state: State, list: Change[]) =>
    Promise.all(
      list.map(async ({ path }) => {
        const before = state.files[path]
          ? await remoteText(state.vaultId, path)
          : "";
        const after = (await m.bytes(path))?.toString("utf8") ?? "";
        return createTwoFilesPatch(`a/${path}`, `b/${path}`, before, after);
      }),
    );

  bb.implement(docs.pull, async (input) => {
    const m = machine(input, input.into);
    const vaultId = input.vault ?? "personal";
    const root = input.path?.replace(/\/$/u, "") ?? "";
    const old = await m.loadState().catch(() => null);
    const state: State = { vaultId, roots: [root], files: { ...old?.files } };
    const all = await bb.call(docs.list, { vault: vaultId });
    const files = all
      .filter((e) => e.kind === "file" && inScope(state, e.path))
      .map((e) => e.path);
    if (!input.folder && !input.all && !files.includes(root))
      fail("not_found", `No document at ${root}`, { reason: "no_document" });
    for (const path of files) {
      const remote = await bb.call(docs.read, { vault: vaultId, path });
      const current = await m.bytes(path);
      const local = current ? sha(current) : null;
      const known = state.files[path];
      if (local && local !== known && known === remote.sha256) continue;
      if (local && local !== known && local !== remote.sha256)
        fail(
          "conflict",
          `Conflict: ${path} changed both locally and in the vault`,
          {
            reason: "pull_conflict",
            hint: "Push or discard the local change, then pull again",
          },
        );
      await m.put(path, Buffer.from(remote.content, remote.contentEncoding));
      state.files[path] = remote.sha256;
    }
    for (const path of Object.keys(state.files))
      if (inScope(state, path) && !files.includes(path)) {
        await m.remove(path);
        delete state.files[path];
      }
    await m.saveState(state);
    return { files };
  });

  bb.implement(docs.status, async (input) => {
    const m = machine(input, input.workspaceDir);
    const state = await m.loadState();
    const list = await changes(m, state, true);
    if (!input.diff) return { changes: list };
    return { changes: list, diffs: await diffs(m, state, list) };
  });

  bb.implement(docs.push, async (input) => {
    const m = machine(input, input.workspaceDir);
    const state = await m.loadState();
    const list = await changes(m, state, input.delete ?? false);
    const shown = input.diff ? { diffs: await diffs(m, state, list) } : {};
    const dryRun = input.dryRun ?? false;
    if (!dryRun)
      for (const { path, status } of list) {
        if (status === "deleted") {
          await bb.call(docs.remove, { vault: state.vaultId, path });
          delete state.files[path];
          continue;
        }
        const content = await m.bytes(path);
        if (!content) continue;
        const { sha256 } = await bb.call(docs.write, {
          vault: state.vaultId,
          path,
          content: content.toString("base64"),
          contentEncoding: "base64",
          expectedSha256: state.files[path] ?? null,
        });
        state.files[path] = sha256;
        await m.saveState(state);
      }
    await m.saveState(state);
    return { changes: list, dryRun, ...shown };
  });
}
