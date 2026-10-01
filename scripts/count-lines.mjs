#!/usr/bin/env node
// Line budget counter.
//
// Counts physical lines of hand-written source and tests (ts, tsx, js, css,
// sql, html and their module-flavour variants). Not counted: lockfiles,
// generated output, vendored third-party code, markdown and JSON (which covers
// migration snapshot JSON).
//
// Usage:
//   node scripts/count-lines.mjs [root] [--max N] [--json] [--depth N] [--top N]
//
// The file list comes from git (tracked + untracked-but-not-ignored), so
// build output and node_modules never count. Exits 1 when --max is exceeded.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const COUNTED_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "css",
  "sql",
  "html",
]);

// Path segments that mark generated or vendored trees.
const EXCLUDED_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "generated",
  "__generated__",
  "vendor",
  "vendored",
  "third_party",
  "third-party",
]);

const EXCLUDED_FILE_PATTERNS = [
  /\.gen\.[cm]?[jt]sx?$/,
  /\.generated\.[cm]?[jt]sx?$/,
  /\.min\.(js|css)$/,
  /\.d\.ts\.map$/,
];

// Directories whose direct children are separate packages.
const WORKSPACE_ROOTS = new Set(["apps", "packages", "plugins", "tests", "examples"]);

function parseArgs(argv) {
  const options = { root: process.cwd(), max: null, json: false, top: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--max") options.max = Number(argv[++index]);
    else if (arg === "--json") options.json = true;
    else if (arg === "--top") options.top = Number(argv[++index]);
    else if (arg.startsWith("--")) throw new Error(`Unknown flag: ${arg}`);
    else options.root = resolve(arg);
  }
  if (options.max !== null && !Number.isFinite(options.max)) {
    throw new Error("--max needs a number");
  }
  return options;
}

function listFiles(root) {
  const output = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    maxBuffer: 256 * 1024 * 1024,
  });
  return output.toString("utf8").split("\0").filter(Boolean);
}

export function isCounted(path) {
  const segments = path.split("/");
  const file = segments[segments.length - 1];
  const dot = file.lastIndexOf(".");
  if (dot < 0) return false;
  if (!COUNTED_EXTENSIONS.has(file.slice(dot + 1))) return false;
  for (const segment of segments.slice(0, -1)) {
    if (EXCLUDED_SEGMENTS.has(segment)) return false;
  }
  return !EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(file));
}

export function areaOf(path) {
  const segments = path.split("/");
  if (segments.length >= 3 && WORKSPACE_ROOTS.has(segments[0])) {
    return `${segments[0]}/${segments[1]}`;
  }
  return segments.length > 1 ? segments[0] : "(root)";
}

function countLines(buffer) {
  if (buffer.length === 0) return 0;
  let lines = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 10) lines += 1;
  }
  if (buffer[buffer.length - 1] !== 10) lines += 1;
  return lines;
}

function isTestFile(path) {
  return /(^|\/)(tests?|__tests__|e2e)\//.test(path) || /\.(test|spec|stories)\.[cm]?[jt]sx?$/.test(path);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const areas = new Map();
  let total = 0;
  let totalTests = 0;
  let files = 0;
  for (const path of listFiles(options.root)) {
    if (!isCounted(path)) continue;
    let buffer;
    try {
      buffer = readFileSync(join(options.root, path));
    } catch {
      continue;
    }
    const lines = countLines(buffer);
    const area = areaOf(path);
    const entry = areas.get(area) ?? { lines: 0, tests: 0, files: 0 };
    entry.lines += lines;
    entry.files += 1;
    if (isTestFile(path)) {
      entry.tests += lines;
      totalTests += lines;
    }
    areas.set(area, entry);
    total += lines;
    files += 1;
  }

  const sorted = [...areas.entries()].sort((a, b) => b[1].lines - a[1].lines);
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ total, tests: totalTests, files, max: options.max, areas: Object.fromEntries(sorted) }, null, 2)}\n`,
    );
  } else {
    const shown = options.top ? sorted.slice(0, options.top) : sorted;
    const width = Math.max(...shown.map(([area]) => area.length), 10);
    console.log(`${"area".padEnd(width)}  ${"lines".padStart(9)}  ${"of which tests".padStart(14)}  ${"files".padStart(6)}`);
    for (const [area, entry] of shown) {
      console.log(
        `${area.padEnd(width)}  ${String(entry.lines).padStart(9)}  ${String(entry.tests).padStart(14)}  ${String(entry.files).padStart(6)}`,
      );
    }
    if (shown.length < sorted.length) console.log(`… ${sorted.length - shown.length} more areas`);
    console.log(`${"TOTAL".padEnd(width)}  ${String(total).padStart(9)}  ${String(totalTests).padStart(14)}  ${String(files).padStart(6)}`);
    if (options.max !== null) {
      const remaining = options.max - total;
      console.log(
        remaining >= 0
          ? `OK: ${total} of ${options.max} lines used (${remaining} left)`
          : `OVER BUDGET: ${total} lines exceeds ${options.max} by ${-remaining}`,
      );
    }
  }
  if (options.max !== null && total > options.max) process.exit(1);
}

main();
