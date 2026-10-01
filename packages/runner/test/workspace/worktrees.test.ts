import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, failureCode, type Harness } from "./harness.js";

const SETUP_SCRIPT = [
  'echo "setting up $(basename "$PWD")"',
  'echo "secret is $(cat .env)" >&2',
  'echo "thread $BB_THREAD_ID"',
].join("\n");

describe("managed worktrees and lifecycle scripts", () => {
  let h: Harness;
  let source: string;
  const branchName = "bb/feature-thr_1";
  const worktree = {
    key: "thr_1-1",
    branchName,
    baseBranch: null,
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
    h.write(path.join(source, ".env"), "TOKEN=1\n");
    h.write(path.join(source, "node_modules/dep/index.js"), "ignored\n");
  });

  afterAll(() => h.dispose());

  it("creates a worktree once, copies included files and reuses it", async () => {
    const created = await h.api.createWorktree({
      sourcePath: source,
      ...worktree,
    });
    expect(created).toEqual({
      path: path.join(h.dataDir, "worktrees", "thr_1-1", "project"),
      branchName,
      mergeBaseBranch: "main",
      worktreeInclude: { copied: 1, skipped: 0 },
    });
    expect(fs.readFileSync(path.join(created.path, ".env"), "utf8")).toBe(
      "TOKEN=1\n",
    );
    expect(fs.existsSync(path.join(created.path, "node_modules"))).toBe(false);
    expect(await h.api.inspectPath({ path: created.path })).toMatchObject({
      isGitRepo: true,
      isWorktree: true,
      branchName,
      dirty: false,
    });

    h.write(path.join(created.path, "work.txt"), "in progress\n");
    const again = await h.api.createWorktree({
      sourcePath: source,
      ...worktree,
    });
    expect(again).toEqual({ ...created, worktreeInclude: null });
    expect(fs.existsSync(path.join(created.path, "work.txt"))).toBe(true);
  });

  it("streams setup output and reports timeouts", async () => {
    const { path: cwd } = await h.api.createWorktree({
      sourcePath: source,
      ...worktree,
    });
    const script = {
      path: cwd,
      timeoutMs: 20_000,
      env: { BB_THREAD_ID: "thr_1" },
    };
    const setup = h.api.runLifecycleScript({
      operationId: "op-setup",
      kind: "setup",
      ...script,
    });
    const joined = h.api.runLifecycleScript({
      operationId: "op-setup",
      kind: "setup",
      ...script,
    });
    expect(await setup).toEqual({ ran: true, exitCode: 0, failure: null });
    expect(await joined).toEqual(await setup);
    const output = h.events
      .filter((event) => event.kind === "script.output")
      .filter((event) => event.operationId === "op-setup")
      .map((event) => event.text)
      .join("\n");
    expect(output.split("\n").sort()).toEqual([
      "secret is TOKEN=1",
      "setting up project",
      "thread thr_1",
    ]);

    const startedAt = Date.now();
    const teardown = await h.api.runLifecycleScript({
      operationId: "op-teardown",
      kind: "teardown",
      ...script,
      timeoutMs: 300,
    });
    expect(teardown).toMatchObject({
      ran: true,
      exitCode: null,
      failure: { reason: "timeout" },
    });
    expect(Date.now() - startedAt).toBeLessThan(10_000);

    const absent = await h.api.runLifecycleScript({
      operationId: "op-none",
      kind: "setup",
      ...script,
      path: h.root,
    });
    expect(absent).toEqual({ ran: false, exitCode: null, failure: null });
  });

  it("removes the worktree, stops processes inside it and keeps the branch", async () => {
    const { path: cwd } = await h.api.createWorktree({
      sourcePath: source,
      ...worktree,
    });
    const lingering = spawn("sleep", ["60"], { cwd, stdio: "ignore" });
    const exited = new Promise((resolve) => lingering.once("exit", resolve));
    await new Promise((resolve) => lingering.once("spawn", resolve));

    await h.api.removeWorktree({ path: cwd });
    await exited;
    expect(lingering.signalCode).toBe("SIGTERM");
    expect(fs.existsSync(cwd)).toBe(false);
    expect(fs.existsSync(`${cwd}.completed`)).toBe(false);
    expect(h.git(source, "branch", "--list", branchName)).toContain(branchName);
    expect(h.git(source, "worktree", "list")).not.toContain("thr_1-1");

    const unmanaged = h.api.removeWorktree({ path: source });
    expect(await failureCode(unmanaged)).toBe("invalid_path");
    expect(fs.existsSync(source)).toBe(true);
  });

  it("restores a removed worktree on its existing branch", async () => {
    h.git(source, "switch", "--quiet", branchName);
    h.write(path.join(source, "kept.txt"), "committed work\n");
    h.git(source, "add", "-A");
    h.git(source, "commit", "--quiet", "-m", "keep me");
    h.git(source, "switch", "--quiet", "main");
    const restored = await h.api.createWorktree({
      sourcePath: source,
      ...worktree,
      key: "thr_1-2",
    });
    expect(fs.existsSync(path.join(restored.path, "kept.txt"))).toBe(true);
  });

  it("switches branches only from a clean checkout", async () => {
    const repo = h.initRepo("checkout", { "a.txt": "a\n" });
    const created = await h.api.switchBranch({
      path: repo,
      branchName: "topic",
      createFrom: "main",
    });
    expect(created).toEqual({ branchName: "topic" });
    expect(h.git(repo, "branch", "--show-current").trim()).toBe("topic");
    h.write(path.join(repo, "a.txt"), "dirty\n");
    const dirty = h.api.switchBranch({
      path: repo,
      branchName: "main",
      createFrom: null,
    });
    expect(await failureCode(dirty)).toBe("conflict");
    const personal = await h.api.ensurePersonalWorkspace({ key: "thr_9" });
    expect(fs.statSync(personal.path).isDirectory()).toBe(true);
    expect(personal.path).toBe(path.join(h.dataDir, "workspaces", "thr_9"));
  });
});
