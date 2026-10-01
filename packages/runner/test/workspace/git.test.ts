import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, failureCode, lines, type Harness } from "./harness.js";

const BINARY = Buffer.from([0, 1, 2, 3, 0, 255, 254, 0]);

describe("git status and diffs", () => {
  let h: Harness;
  let repo: string;
  let mainSha: string;
  let featureSha: string;

  beforeAll(() => {
    h = createHarness();
    repo = h.initRepo("repo", {
      "tracked.txt": "one\ntwo\nthree\n",
      "rename-me.txt": lines(20),
      "binary.bin": BINARY,
      ".gitignore": "ignored.log\n",
    });
    mainSha = h.git(repo, "rev-parse", "HEAD").trim();
    h.git(repo, "switch", "--quiet", "-c", "feature");
    h.write(path.join(repo, "committed.txt"), "committed\n");
    h.git(repo, "add", "-A");
    h.git(repo, "commit", "--quiet", "-m", "add committed file");
    featureSha = h.git(repo, "rev-parse", "HEAD").trim();
    h.write(path.join(repo, "staged.txt"), "staged\n");
    h.git(repo, "add", "staged.txt");
    h.git(repo, "mv", "rename-me.txt", "renamed.txt");
    h.write(path.join(repo, "tracked.txt"), "one\nTWO\nthree\nfour\n");
    h.write(path.join(repo, "binary.bin"), Buffer.concat([BINARY, BINARY]));
    h.write(path.join(repo, "new.txt"), "fresh\nfile\n");
    h.write(path.join(repo, "blob.bin"), BINARY);
    h.write(path.join(repo, "large.txt"), lines(600));
    h.write(path.join(repo, "huge.txt"), lines(20_500, "x".repeat(40)));
    h.write(path.join(repo, "ignored.log"), "noise\n");
  });

  afterAll(() => h.dispose());

  it("reports working tree, branch and merge base", async () => {
    const status = await h.api.gitStatus({
      path: repo,
      mergeBaseBranch: "main",
    });
    const byPath = new Map(
      status.workingTree.files.map((file) => [file.path, file]),
    );
    expect(status.workingTree.state).toBe("dirty_and_committed_unmerged");
    expect(status.workingTree.hasUncommittedChanges).toBe(true);
    expect(byPath.get("tracked.txt")).toMatchObject({
      status: "M",
      insertions: 2,
      deletions: 1,
    });
    expect(byPath.get("staged.txt")?.status).toBe("A");
    expect(byPath.get("renamed.txt")?.status).toBe("R");
    expect(byPath.get("new.txt")).toMatchObject({
      status: "??",
      insertions: 2,
    });
    expect(byPath.has("ignored.log")).toBe(false);
    expect(status.workingTree.lineStatsComplete).toBe(true);
    expect(status.branch).toEqual({
      currentBranch: "feature",
      defaultBranch: "main",
    });
    expect(status.checkout).toEqual({
      kind: "branch",
      branchName: "feature",
      headSha: featureSha,
    });
    expect(status.mergeBase).toMatchObject({
      baseRef: mainSha,
      aheadCount: 1,
      behindCount: 0,
      hasCommittedUnmergedChanges: true,
      insertions: 1,
    });
    expect(status.mergeBase?.commits[0]?.subject).toBe("add committed file");
    expect(status.mergeBase?.files).toEqual([
      { path: "committed.txt", status: "A", insertions: 1, deletions: 0 },
    ]);
  });

  it("lists uncommitted files with tiers, renames, binaries and untracked", async () => {
    const diff = await h.api.gitDiffFiles({
      path: repo,
      target: { type: "uncommitted" },
    });
    const byPath = new Map(diff.files.map((file) => [file.path, file]));
    expect(diff.truncated).toBe(false);
    expect(byPath.get("renamed.txt")).toMatchObject({
      changeKind: "renamed",
      previousPath: "rename-me.txt",
      origin: "tracked",
    });
    expect(byPath.get("binary.bin")).toMatchObject({
      binary: true,
      loadMode: "on_demand",
    });
    expect(byPath.get("blob.bin")).toMatchObject({
      binary: true,
      origin: "untracked",
      changeKind: "added",
    });
    expect(byPath.get("new.txt")).toMatchObject({
      additions: 2,
      origin: "untracked",
      loadMode: "auto",
    });
    expect(byPath.get("large.txt")?.loadMode).toBe("on_demand");
    expect(byPath.get("huge.txt")?.loadMode).toBe("too_large");
    expect(byPath.has("ignored.log")).toBe(false);
    expect(byPath.has("committed.txt")).toBe(false);
    expect(diff.shortstat).toMatch(/^8 files changed, \d+ insertions/u);
    const initial = new Map(
      diff.initialPatches.map((entry) => [entry.path, entry.patch]),
    );
    expect([...initial.keys()].sort()).toEqual([
      "new.txt",
      "renamed.txt",
      "staged.txt",
      "tracked.txt",
    ]);
    expect(initial.get("tracked.txt")).toContain("+TWO");
    expect(initial.get("new.txt")).toContain("+fresh");
  });

  it("returns one bounded patch per requested path", async () => {
    const { patches } = await h.api.gitDiffPatch({
      path: repo,
      target: { type: "uncommitted" },
      paths: ["renamed.txt", "huge.txt", "binary.bin", "missing.txt"],
    });
    expect(patches.map((entry) => entry.path)).toEqual([
      "renamed.txt",
      "huge.txt",
      "binary.bin",
      "missing.txt",
    ]);
    expect(patches[0]?.patch).toContain("rename from rename-me.txt");
    expect(patches[1]?.truncated).toBe(true);
    expect(patches[1]?.patch.length).toBeLessThanOrEqual(512 * 1024);
    expect(patches[2]?.patch).toContain("GIT binary patch");
    expect(patches[3]).toEqual({
      path: "missing.txt",
      patch: "",
      truncated: false,
    });
    const total = patches.reduce((sum, entry) => sum + entry.patch.length, 0);
    expect(total).toBeLessThan(700 * 1024);
  });

  it("diffs committed work, everything since the merge base, and one commit", async () => {
    const mergeBaseBranch = "main";
    const committed = await h.api.gitDiffFiles({
      path: repo,
      target: { type: "branch_committed", mergeBaseBranch },
    });
    expect(committed.mergeBaseRef).toBe(mainSha);
    expect(committed.files.map((file) => file.path)).toEqual(["committed.txt"]);
    expect(committed.initialPatches[0]?.patch).toContain("+committed");

    const all = await h.api.gitDiffFiles({
      path: repo,
      target: { type: "all", mergeBaseBranch },
    });
    const allPaths = all.files.map((file) => file.path);
    expect(allPaths).toEqual(
      expect.arrayContaining(["committed.txt", "tracked.txt", "new.txt"]),
    );

    const commit = await h.api.gitDiffFiles({
      path: repo,
      target: { type: "commit", sha: featureSha },
    });
    expect(commit.files).toMatchObject([
      { path: "committed.txt", changeKind: "added", additions: 1 },
    ]);

    const whole = await h.api.gitDiff({
      path: repo,
      target: { type: "all", mergeBaseBranch },
    });
    expect(whole.diff).toContain("+++ b/committed.txt");
    expect(whole.diff).toContain("diff --git a/blob.bin b/blob.bin");
    expect(whole.files).toContain("R\trename-me.txt\trenamed.txt");
    expect(whole.truncated).toBe(true);
    expect(Buffer.byteLength(whole.diff)).toBeLessThanOrEqual(640 * 1024);
  });

  it("reads both sides of a changed file", async () => {
    const file = { target: "uncommitted", path: "tracked.txt" } as const;
    const before = await h.api.gitDiffFile({
      path: repo,
      file: { ...file, side: "old" },
    });
    const after = await h.api.gitDiffFile({
      path: repo,
      file: { ...file, side: "new" },
    });
    expect(before.content).toBe("one\ntwo\nthree\n");
    expect(after).toMatchObject({
      content: "one\nTWO\nthree\nfour\n",
      contentEncoding: "utf8",
      mimeType: "text/plain",
    });
  });

  it("inspects paths and lists branches with the default first", async () => {
    expect(await h.api.inspectPath({ path: repo })).toEqual({
      exists: true,
      isGitRepo: true,
      isWorktree: false,
      branchName: "feature",
      defaultBranch: "main",
      remoteUrl: null,
      dirty: true,
    });
    const missing = await h.api.inspectPath({ path: path.join(h.root, "no") });
    expect(missing).toMatchObject({ exists: false, isGitRepo: false });
    const source = await h.api.inspectGitSource({ path: repo });
    expect(source).toMatchObject({
      defaultBranch: "main",
      hasUncommittedChanges: true,
      operation: { kind: "none" },
    });
    const branches = await h.api.listBranches({
      path: repo,
      limit: 1,
      selectedBranch: "gone",
    });
    expect(branches).toEqual({
      branches: ["main"],
      branchesTruncated: true,
      remoteBranches: [],
      remoteBranchesTruncated: false,
      selectedBranch: { name: "gone", kind: "missing" },
    });
    const filtered = await h.api.listBranches({
      path: repo,
      limit: 10,
      query: "FEAT",
    });
    expect(filtered.branches).toEqual(["feature"]);
  });

  it("commits everything once and then reports no changes", async () => {
    const result = await h.api.gitCommit({ path: repo, message: "ship it" });
    expect(result.commitSubject).toBe("ship it");
    expect(h.git(repo, "rev-parse", "HEAD").trim()).toBe(result.commitSha);
    expect(fs.existsSync(path.join(repo, "ignored.log"))).toBe(true);
    const status = await h.api.gitStatus({ path: repo });
    expect(status.workingTree).toMatchObject({ state: "clean", files: [] });
    const again = h.api.gitCommit({ path: repo, message: "nothing" });
    expect(await failureCode(again)).toBe("no_changes");
    const outside = h.api.gitStatus({ path: h.root });
    expect(await failureCode(outside)).toBe("not_git_repo");
  });
});
