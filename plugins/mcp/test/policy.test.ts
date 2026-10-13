import { plugins } from "@bb/plugin";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createTestServer } from "../../../apps/server/test/helpers.js";
import { mcp } from "../contract.js";
import {
  parseCommandReference,
  pluginCommandIndex,
} from "../src/command-index.js";
import {
  evaluateCliAccess,
  NATIVE_READ_ONLY_COMMAND_PATHS,
  PLUGIN_READ_ONLY_COMMAND_PATHS,
  READ_ONLY_COMMAND_PATHS,
} from "../src/policy.js";

const NATIVE_REFERENCE = new URL(
  "../../../crates/bb-cli/tests/fixtures/guide-commands.txt",
  import.meta.url,
);

const KNOWN_PATHS = new Set([
  "status",
  "guide",
  "thread list",
  "thread show",
  "thread tell",
  "thread spawn",
  "thread delete",
  "thread options",
  "thread queue list",
  "thread queue send",
  "env diff",
  "env diff-file",
  "env commit",
  "file read",
  "file write",
  "terminal send",
  "terminal output",
  "machine env list",
  "machine env set",
  "docs list",
  "docs write",
  "dev watch",
  "runner run",
  "server",
  "server status",
]);

function allowed(argv: string[], mode: "read" | "write"): boolean {
  return evaluateCliAccess(argv, mode, KNOWN_PATHS).allowed;
}

describe("evaluateCliAccess in read mode", () => {
  it.each([
    [["status"]],
    [["thread", "list", "--json"]],
    [["thread", "show", "thr_1"]],
    [["thread", "queue", "list", "thr_1"]],
    [["env", "diff", "env_1", "--json"]],
    [["file", "read", "/tmp/x"]],
    [["machine", "env", "list"]],
    [["docs", "list"]],
    [["server", "status"]],
    [["guide", "commands", "thread"]],
    [["--version"]],
  ])("allows %j", (argv) => {
    expect(allowed(argv, "read")).toBe(true);
  });

  it.each([
    [["thread", "tell", "thr_1", "hello"]],
    [["thread", "spawn", "--project", "proj_1"]],
    [["thread", "delete", "thr_1"]],
    [["thread", "options", "thr_1"]],
    [["thread", "queue", "send", "thr_1", "msg_1"]],
    [["env", "commit", "env_1"]],
    [["file", "write", "/tmp/x"]],
    [["terminal", "send", "term_1"]],
    [["machine", "env", "set", "A"]],
    [["docs", "write", "note.md"]],
    [["unknown", "command"]],
  ])("refuses %j", (argv) => {
    expect(allowed(argv, "read")).toBe(false);
  });

  it("refuses aliases and other spellings", () => {
    expect(allowed(["threads", "list"], "read")).toBe(false);
    expect(allowed(["thread", "get", "thr_1"], "read")).toBe(false);
    expect(allowed(["environment", "diff", "env_1"], "read")).toBe(false);
    expect(allowed(["logs", "thr_1"], "read")).toBe(false);
  });

  it("refuses an allowed command reached through leading options", () => {
    expect(allowed(["--json", "thread", "list"], "read")).toBe(false);
    expect(allowed(["thread", "--json", "delete", "thr_1"], "read")).toBe(
      false,
    );
  });

  it("allows help only for a known command path with nothing else", () => {
    expect(allowed(["thread", "tell", "--help"], "read")).toBe(true);
    expect(allowed(["thread", "--help"], "read")).toBe(true);
    expect(allowed(["--help"], "read")).toBe(true);
    expect(allowed(["thread", "tell", "thr_1", "--help"], "read")).toBe(false);
    expect(allowed(["terminal", "send", "term_1", "--help"], "read")).toBe(
      false,
    );
    expect(allowed(["thread", "tell", "thr_1", "--", "--help"], "read")).toBe(
      false,
    );
    expect(allowed(["nothing", "--help"], "read")).toBe(false);
  });
});

describe("READ_ONLY_COMMAND_PATHS", () => {
  const native = parseCommandReference(readFileSync(NATIVE_REFERENCE, "utf8"));
  const nativePaths = new Set(native.map(({ path }) => path));

  it("lists only built-in commands the bb CLI really has", () => {
    const unknown = NATIVE_READ_ONLY_COMMAND_PATHS.filter(
      (path) => !nativePaths.has(path),
    );
    expect(unknown).toEqual([]);
  });

  it("lists only plugin commands that are operations declared as reads on a running server", async () => {
    const { ctx } = await createTestServer({}, "fake", ":memory:", "all");
    const [described, contributed] = await Promise.all([
      ctx.kernel.call(plugins.contracts, {}),
      ctx.kernel.call(plugins.contributions, {}),
    ]);
    const own = [{ members: { ...mcp } }];
    const index = pluginCommandIndex(
      [...described.contracts, ...pluginCommandContracts(own)],
      contributed.cliCommands,
    );
    const kinds = new Map(index.map(({ path, kind }) => [path, kind]));
    const unknown = PLUGIN_READ_ONLY_COMMAND_PATHS.filter(
      (path) => !kinds.has(path),
    );
    expect(unknown).toEqual([]);
    const undeclared = PLUGIN_READ_ONLY_COMMAND_PATHS.filter(
      (path) => kinds.get(path) !== "read",
    );
    expect(undeclared).toEqual([]);
    const shadowed = PLUGIN_READ_ONLY_COMMAND_PATHS.filter((path) =>
      nativePaths.has(path),
    );
    expect(shadowed).toEqual([]);
  });

  it("holds each path once", () => {
    const listed = [
      ...NATIVE_READ_ONLY_COMMAND_PATHS,
      ...PLUGIN_READ_ONLY_COMMAND_PATHS,
    ];
    expect(listed).toHaveLength(READ_ONLY_COMMAND_PATHS.size);
  });
});

function pluginCommandContracts(
  contracts: { members: Record<string, unknown> }[],
) {
  return contracts.map(({ members }) => {
    const described = Object.entries(members).map(([key, member]) => {
      const { kind, doors } = member as {
        kind?: string;
        doors?: { cli?: { path: string; summary: string } };
      };
      const cli = doors?.cli;
      const shown = cli && { path: cli.path, summary: cli.summary };
      return [key, { kind, doors: { cli: shown } }];
    });
    return { members: Object.fromEntries(described) };
  });
}

describe("evaluateCliAccess in write mode", () => {
  it.each([
    [["thread", "tell", "thr_1", "hello"]],
    [["file", "write", "/tmp/x"]],
    [["docs", "list"]],
    [["threads", "list"]],
  ])("allows %j", (argv) => {
    expect(allowed(argv, "write")).toBe(true);
  });

  it.each([
    [["server"]],
    [["server", "--port", "1"]],
    [["runner", "run"]],
    [["dev", "watch", "/tmp/plugin"]],
  ])("refuses %j, which cannot run over MCP", (argv) => {
    expect(allowed(argv, "write")).toBe(false);
    expect(allowed(argv, "read")).toBe(false);
  });

  it.each([
    [["server", "status"]],
    [["machine", "add"]],
    [["dev", "new", "demo"]],
    [["mcp", "revoke", "grant_1"]],
  ])("allows %j", (argv) => {
    expect(allowed(argv, "write")).toBe(true);
  });

  it("refuses oversized or malformed argument lists", () => {
    expect(allowed(new Array(65).fill("x"), "write")).toBe(false);
    expect(allowed(["thread", "tell", "a\0b"], "write")).toBe(false);
    expect(allowed(["thread", "tell", "x".repeat(200_001)], "write")).toBe(
      false,
    );
  });
});
