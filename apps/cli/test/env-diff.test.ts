import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { commitAll, git } from "../../server/test/helpers.js";
import { parsed, startBb } from "./helpers.js";

interface Shown {
  environment: { id: string; path: string };
}

it("reads branches, paths and diffs of an environment like the original", async () => {
  const { bb } = await startBb();
  const root = mkdtempSync(join(tmpdir(), "bb-env-diff-"));
  git(root, "init", "--quiet", "-b", "main");
  writeFileSync(join(root, "README.md"), "hi\n");
  commitAll(root);
  const create = ["project", "create", "--name", "g", "--root", root, "--json"];
  const project = parsed<{ id: string }>(await bb(create));
  const spawn = ["thread", "spawn", "--project", project.id];
  const echo = ["--provider", "echo", "--prompt", "hi", "--json"];
  const thread = parsed<{ id: string }>(await bb([...spawn, ...echo]));
  const shown = await bb(["thread", "show", thread.id, "--json"]);
  const { id, path } = parsed<Shown>(shown).environment;
  writeFileSync(join(path, "a.txt"), "a\n");
  const files = await bb(["env", "diff-files", id, "--target", "uncommitted"]);
  expect([files.code, files.stdout]).toEqual([
    0,
    expect.stringContaining("added\t+1 -0\tuntracked\tauto\ta.txt\n"),
  ]);
  const patch = ["env", "diff-patch", id, "--target", "uncommitted"];
  const patched = await bb([...patch, "--path", "a.txt", "--json"]);
  expect(parsed<{ outcome: string }>(patched).outcome).toBe("available");
  const diff = await bb(["env", "diff", id, "--target", "uncommitted"]);
  expect([diff.code, diff.stdout]).toEqual([
    0,
    expect.stringMatching(/^added\ta\.txt\n.*\ndiff --git a\/a\.txt/s),
  ]);
  const paths = await bb(["env", "paths", id, "--files"]);
  expect(paths.stdout).toContain("file\ta.txt\n");
  const missing = await bb([...patch, "--json"]);
  const error = { code: "invalid_value", message: expect.any(String) };
  expect([missing.code, parsed(missing)]).toEqual([1, { ok: false, error }]);
  const all = await bb(["env", "diff-files", id, "--target", "all"]);
  expect(all.stderr).toContain("--merge-base-branch is required");
  const archived = await bb(["env", "archive-threads", id, "--json"]);
  expect(parsed(archived)).toEqual({
    ok: true,
    archivedThreadIds: [thread.id],
  });
}, 120_000);
