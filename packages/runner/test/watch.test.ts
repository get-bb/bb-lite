import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import type { Ctx } from "../src/workspace/exec.js";
import { createWatcher } from "../src/workspace/watch.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function write(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

it("watches a folder as a repository once it becomes one", async () => {
  const folder = mkdtempSync(join(tmpdir(), "bb-watch-"));
  const changes: string[] = [];
  const ctx: Ctx = {
    dataDir: mkdtempSync(join(tmpdir(), "bb-watch-data-")),
    sink: (event) => {
      if (event.kind === "workspace.changed") changes.push(event.change);
    },
    env: async () => process.env,
    lock: (_key, work) => work(),
  };
  const watcher = createWatcher(ctx);
  const watched = { workspaces: [folder], directories: [] };
  await watcher.setWatchedPaths({ generation: 1, ...watched });
  await pause(300);

  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: folder });
  write(join(folder, "src/main.js"), "1\n");
  await pause(1500);
  expect(changes).toContain("status");

  changes.length = 0;
  write(join(folder, ".git/objects/zz/loose-object"), "x");
  write(join(folder, ".git/logs/HEAD"), "x");
  await pause(900);
  expect(changes).toEqual([]);

  write(join(folder, ".git/HEAD"), "ref: refs/heads/other\n");
  await pause(900);
  expect(changes.sort()).toEqual(["refs", "status"]);
  await watcher.dispose();
});
