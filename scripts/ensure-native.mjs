#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromServer = createRequire(join(root, "apps/server/package.json"));

function loads() {
  try {
    execFileSync(
      process.execPath,
      ["-e", "new (require('better-sqlite3'))(':memory:').close()"],
      { cwd: join(root, "apps/server"), stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

if (!loads()) {
  const moduleDir = dirname(
    requireFromServer.resolve("better-sqlite3/package.json"),
  );
  const prebuild = requireFromServer.resolve("prebuild-install/bin.js", {
    paths: [moduleDir],
  });
  execFileSync(process.execPath, [prebuild], {
    cwd: moduleDir,
    stdio: "inherit",
  });
  if (!loads()) {
    console.error("better-sqlite3 does not load on this Node version");
    process.exit(1);
  }
}
