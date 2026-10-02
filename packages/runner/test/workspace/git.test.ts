import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { byPath, createHarness } from "./harness.js";
import type { Harness } from "./harness.js";

describe("git status, branches and diffs", () => {
  let h: Harness;
  let repo: string;
  let mainSha: string;
  let featureSha: string;
  const mergeBaseBranch = "main";

  beforeAll(() => {
    h = createHarness();
    repo = h.initRepo("repo", {
      "tracked.txt": "one\ntwo\nthree\n",
      "rename-me.txt": "same\n".repeat(20),
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
      "new.txt": "fresh\nfile\n",
      "ignored.log": "noise\n",
    });
  });

  afterAll(() => h.dispose());

  it("reports the working tree, merge base and branches", async () => {
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
    const first = { path: repo, limit: 1, selectedBranch: "gone" };
    expect(await h.api.listBranches(first)).toMatchObject({
      branches: ["main"],
      branchesTruncated: true,
      selectedBranch: { name: "gone", kind: "missing" },
    });
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
});
