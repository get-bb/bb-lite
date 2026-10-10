import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, failureCode, type Harness } from "./harness.js";

const SETUP_SCRIPT = [
  'echo "setup $(basename "$PWD")"',
  'echo "secret $(cat .env)" >&2',
  'echo "thread $BB_THREAD_ID"',
].join("\n");
type Kind = "setup" | "teardown";

describe("managed worktrees and lifecycle scripts", () => {
  let h: Harness;
  let source: string;
  const branchName = "bb/feature-thr_1";
  const create = (key = "thr_1-1", branch = branchName) => {
    const names = { key, branchName: branch, baseBranch: null };
    return h.api.createWorktree({ sourcePath: source, ...names });
  };

  beforeAll(() => {
    h = createHarness();
    source = h.initRepo("project", {
      "README.md": "# project\n",
      ".gitignore": ".env\nnode_modules/\n",
      ".worktreeinclude": "# local secrets\n.env\n",
      ".bb-env-setup.sh": SETUP_SCRIPT,
      ".bb-env-teardown.sh": "sleep 30\n",
    });
    h.write(source, { ".env": "TOKEN=1\n", "node_modules/dep/x.js": "x\n" });
  });

  afterAll(() => h.dispose());

  it("copies included files, streams setup output and enforces the timeout", async () => {
    const setupNames = ["thr_2-1", "bb/setup-thr_2"] as const;
    const created = await create(...setupNames);
    const cwd = created.path;
    expect(created.worktreeInclude).toEqual({ copied: 1, skipped: 0 });
    expect(fs.existsSync(path.join(cwd, "node_modules"))).toBe(false);
    expect((await create(...setupNames)).worktreeInclude).toBeNull();
    const script = { path: cwd, env: { BB_THREAD_ID: "thr_1" } };
    const run = (operationId: string, kind: Kind, timeoutMs = 20_000) =>
      h.api.runLifecycleScript({ operationId, kind, timeoutMs, ...script });
    const [setup, joined] = await Promise.all([
      run("op-setup", "setup"),
      run("op-setup", "setup"),
    ]);
    expect(setup).toEqual({ ran: true, exitCode: 0, failure: null });
    expect(joined).toEqual(setup);
    const output = h.events
      .filter((event) => event.kind === "script.output")
      .flatMap((event) => event.text.trimEnd().split("\n"));
    const expected = ["secret TOKEN=1", "setup project", "thread thr_1"];
    expect(output.sort()).toEqual(expected);

    const teardown = await run("op-teardown", "teardown", 300);
    expect(teardown).toMatchObject({ ran: true, exitCode: null });
    expect(teardown.failure?.reason).toBe("timeout");
  });

  it("removes the worktree, stops processes inside it and keeps the branch", async () => {
    const { path: cwd } = await create();
    h.write(cwd, { "kept.txt": "committed work\n" });
    h.commitAll(cwd, "keep me");
    const lingering = spawn("sleep", ["60"], { cwd, stdio: "ignore" });
    const exited = new Promise((resolve) => lingering.once("exit", resolve));
    await new Promise((resolve) => lingering.once("spawn", resolve));

    await h.api.removeWorktree({ path: cwd });
    await exited;
    expect(lingering.signalCode).toBe("SIGTERM");
    expect(fs.existsSync(cwd) || fs.existsSync(`${cwd}.completed`)).toBe(false);
    expect(h.git(source, "worktree", "list")).not.toContain("thr_1-1");
    const unmanaged = h.api.removeWorktree({ path: source });
    expect(await failureCode(unmanaged)).toBe("invalid_path");

    const restored = await create("thr_1-2");
    expect(fs.existsSync(path.join(restored.path, "kept.txt"))).toBe(true);
    h.write(restored.path, { "kept.txt": "dirty\n" });
    const names = { branchName: "main", createFrom: null };
    const dirty = h.api.switchBranch({ path: restored.path, ...names });
    expect(await failureCode(dirty)).toBe("conflict");
  });
});
