import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { byPath, createHarness, failureCode } from "./harness.js";
import type { Harness } from "./harness.js";

const BINARY = Buffer.from([0, 1, 2, 3, 0, 255, 254, 0]);
const KIB = 1024;

describe("git status, diffs and commits", () => {
  let h: Harness;
  let repo: string;
  let mainSha: string;
  let featureSha: string;
  const uncommitted = { type: "uncommitted" } as const;
  const mergeBaseBranch = "main";

  beforeAll(() => {
    h = createHarness();
    repo = h.initRepo("repo", {
      "tracked.txt": "one\ntwo\nthree\n",
      "rename-me.txt": "same\n".repeat(20),
      "binary.bin": BINARY,
      ".gitignore": "ignored.log\n",
    });
    mainSha = h.git(repo, "rev-parse", "HEAD");
    h.git(repo, "switch", "--quiet", "-c", "feature");
    h.write(repo, { "committed.txt": "committed\n" });
    featureSha = h.commitAll(repo, "add committed file");
    h.write(repo, { "staged.txt": "staged\n" });
    h.git(repo, "add", "staged.txt");
    h.git(repo, "mv", "rename-me.txt", "renamed.txt");
    h.write(repo, {
      "tracked.txt": "one\nTWO\nthree\nfour\n",
      "binary.bin": Buffer.concat([BINARY, BINARY]),
      "new.txt": "fresh\nfile\n",
      "blob.bin": BINARY,
      "large.txt": "same\n".repeat(600),
      "huge.txt": `${"x".repeat(40)}\n`.repeat(20_500),
      "ignored.log": "noise\n",
    });
  });

  afterAll(() => h.dispose());

  it("reports the working tree, branch and merge base", async () => {
    const status = await h.api.gitStatus({ path: repo, mergeBaseBranch });
    const files = byPath(status.workingTree.files);
    const tracked = { status: "M", insertions: 2, deletions: 1 };
    const state = "dirty_and_committed_unmerged";
    expect(status.workingTree).toMatchObject({
      state,
      lineStatsComplete: true,
    });
    expect(files.get("tracked.txt")).toMatchObject(tracked);
    expect(files.get("staged.txt")?.status).toBe("A");
    expect(files.get("renamed.txt")?.status).toBe("R");
    expect(files.get("new.txt")).toMatchObject({ status: "??", insertions: 2 });
    expect(files.has("ignored.log")).toBe(false);
    const checkout = { kind: "branch", branchName: "feature" };
    expect(status.checkout).toEqual({ ...checkout, headSha: featureSha });
    expect(status.mergeBase).toMatchObject({
      baseRef: mainSha,
      aheadCount: 1,
      behindCount: 0,
      commits: [{ sha: featureSha, subject: "add committed file" }],
      files: [{ path: "committed.txt", status: "A", insertions: 1 }],
    });
  });

  it("tiers uncommitted files and bounds their patches", async () => {
    const diff = await h.api.gitDiffFiles({ path: repo, target: uncommitted });
    const files = byPath(diff.files);
    const renamed = { changeKind: "renamed", previousPath: "rename-me.txt" };
    const added = { additions: 2, origin: "untracked", loadMode: "auto" };
    expect(files.get("renamed.txt")).toMatchObject(renamed);
    expect(files.get("binary.bin")?.binary).toBe(true);
    expect(files.get("blob.bin")).toMatchObject({ binary: true, additions: 0 });
    expect(files.get("new.txt")).toMatchObject(added);
    expect(files.get("large.txt")?.loadMode).toBe("on_demand");
    expect(files.get("huge.txt")?.loadMode).toBe("too_large");
    expect(files.has("ignored.log") || files.has("committed.txt")).toBe(false);
    expect(diff.shortstat).toMatch(/^8 files changed, \d+ insertions/u);
    const initial = byPath(diff.initialPatches);
    const auto = ["new.txt", "renamed.txt", "staged.txt", "tracked.txt"];
    expect([...initial.keys()].sort()).toEqual(auto);
    expect(initial.get("tracked.txt")?.patch).toContain("+TWO");
    expect(initial.get("new.txt")?.patch).toContain("+fresh");

    const paths = ["renamed.txt", "huge.txt", "binary.bin", "missing.txt"];
    const request = { path: repo, target: uncommitted, paths };
    const { patches } = await h.api.gitDiffPatch(request);
    expect(patches.map((entry) => entry.path)).toEqual(paths);
    expect(patches[0]?.patch).toContain("rename from rename-me.txt");
    expect(patches[1]?.truncated).toBe(true);
    expect(patches[1]?.patch.length).toBeLessThanOrEqual(512 * KIB);
    expect(patches[2]?.patch).toContain("GIT binary patch");
    expect(patches[3]).toMatchObject({ patch: "", truncated: false });
    const total = patches.reduce((sum, entry) => sum + entry.patch.length, 0);
    expect(total).toBeLessThan(700 * KIB);
  });

  it("diffs the branch, everything since the merge base, and one commit", async () => {
    const files = async (
      target: Parameters<typeof h.api.gitDiffFiles>[0]["target"],
    ) => h.api.gitDiffFiles({ path: repo, target });
    const committed = await files({
      type: "branch_committed",
      mergeBaseBranch,
    });
    expect(committed.mergeBaseRef).toBe(mainSha);
    expect(committed.files.map((file) => file.path)).toEqual(["committed.txt"]);
    expect(committed.initialPatches[0]?.patch).toContain("+committed");

    const everything = { type: "all", mergeBaseBranch } as const;
    const all = byPath((await files(everything)).files);
    const expected = ["committed.txt", "tracked.txt", "new.txt"];
    expect(expected.filter((file) => all.has(file))).toEqual(expected);
    const commit = await files({ type: "commit", sha: featureSha });
    const added = { path: "committed.txt", changeKind: "added", additions: 1 };
    expect(commit.files).toMatchObject([added]);
  });

  it("reads a changed file, lists branches, commits once", async () => {
    const file = { target: "uncommitted", path: "tracked.txt" } as const;
    const side = (which: "old" | "new") =>
      h.api.gitDiffFile({ path: repo, file: { ...file, side: which } });
    expect((await side("old")).content).toBe("one\ntwo\nthree\n");
    expect((await side("new")).content).toBe("one\nTWO\nthree\nfour\n");
    const first = { path: repo, limit: 1, selectedBranch: "gone" };
    expect(await h.api.listBranches(first)).toMatchObject({
      branches: ["main"],
      branchesTruncated: true,
      selectedBranch: { name: "gone", kind: "missing" },
    });

    const result = await h.api.gitCommit({ path: repo, message: "ship it" });
    expect(result.commitSubject).toBe("ship it");
    expect(h.git(repo, "rev-parse", "HEAD")).toBe(result.commitSha);
    const status = await h.api.gitStatus({ path: repo });
    expect(status.workingTree).toMatchObject({ state: "clean", files: [] });
    const again = h.api.gitCommit({ path: repo, message: "nothing" });
    expect(await failureCode(again)).toBe("no_changes");
  });
});
