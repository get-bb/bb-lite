import { expect, it } from "vitest";
import {
  commandPaths,
  parseCommands,
  parseInvocation,
  resolveCommand,
} from "../src/engine.js";
import { handlers, table } from "../src/table.js";
import { runBb } from "./helpers.js";

const run = async (): Promise<void> => {};

it("declares each command once with a summary, a handler and its groups", () => {
  const paths = table.commands.flatMap(commandPaths);
  expect(new Set(paths).size).toBe(paths.length);
  const prefixes = [...Object.keys(table.groups), ...paths];
  for (const spec of table.commands) {
    expect(spec.summary.length, spec.path).toBeGreaterThan(10);
    const flags = spec.flags.flatMap((flag) => flag.names);
    expect(new Set(flags).size, spec.path).toBe(flags.length);
    const words = spec.path.split(" ");
    const parents = words.slice(1).map((_, at) => words.slice(0, at + 1));
    for (const parent of parents) expect(prefixes).toContain(parent.join(" "));
  }
  expect(table.commands.length).toBe(Object.keys(handlers).length);
  const firstWords = paths.map((path) => path.split(" ")[0]);
  for (const alias of Object.keys(table.aliases)) {
    expect(firstWords).not.toContain(alias);
    expect(resolveCommand(table, [alias]).kind, alias).not.toBe("other");
  }
});

it("parses the table text into arguments, aliases and typed flags", () => {
  const text = `
demo run|go <id> [rest...]  Run a demo command
  --name|label <text>  A value
  --tag <tag>...  Several values
  --reuse [path]  An optional value
  --dry  A switch
  $ bb demo run thr_1 --dry
  > {ok}
`;
  const [spec] = parseCommands(text, { demoRun: run });
  if (spec === undefined) throw new Error("The demo command did not parse");
  expect(spec).toMatchObject({
    path: "demo run",
    aliases: ["go"],
    json: "{ok}",
  });
  expect(spec.flags.map((flag) => flag.kind)).toEqual([
    "string",
    "list",
    "optional",
    "boolean",
    "boolean",
    "boolean",
  ]);
  const argv = ["thr_1", "--label=x", "--tag", "a", "--tag", "b", "--reuse"];
  const parsed = parseInvocation(spec, [...argv, "--dry", "--", "--raw", "-"]);
  expect(parsed.args).toEqual({ id: "thr_1" });
  expect(parsed.rest).toEqual(["--raw", "-"]);
  const expected = { name: ["x"], tag: ["a", "b"], reuse: [], dry: [] };
  expect(Object.fromEntries(parsed.flags)).toEqual(expected);
  expect(() => parseInvocation(spec, [])).toThrow("Missing <id>.");
  expect(() => parseInvocation(spec, ["x", "--name"])).toThrow("needs a value");
  expect(() => parseCommands(text, {})).toThrow("has no handler");
  const malformed = text.replace("--dry  A", "--dry A");
  expect(() => parseCommands(malformed, { demoRun: run })).toThrow("--dry A");
});

it("resolves aliases, nested groups and unknown words", () => {
  const resolved = (...argv: string[]) => {
    const found = resolveCommand(table, argv);
    return found.kind === "command" ? [found.spec.path, found.argv] : found;
  };
  expect(resolved("models", "codex")).toEqual(["provider models", ["codex"]]);
  expect(resolved("section", "list")).toEqual(["thread section list", []]);
  expect(resolved("environment", "get", "env_1")).toEqual([
    "env show",
    ["env_1"],
  ]);
  expect(resolved("thread", "status", "thr_1", "--json")).toEqual([
    "thread show",
    ["thr_1", "--json"],
  ]);
  expect(resolved("server", "status")).toEqual(["server status", []]);
  const group = { kind: "group", group: "thread queue", unknown: "peek" };
  expect(resolved("thread", "queue", "peek")).toEqual(group);
  expect(resolved("tasks", "show", "ABC-1")).toMatchObject({ name: "tasks" });
});

it("prints help for a group, a leaf command and the generated guide", async () => {
  const group = await runBb(["thread", "--help"]);
  expect(group.code).toBe(0);
  expect(group.stdout).toContain("Usage: bb thread <command> [options]");
  expect(group.stdout).toMatch(/\n {2}spawn +Create a thread and send/u);
  const leaf = await runBb(["thread", "wait", "--help"]);
  expect(leaf.stdout).toContain("Usage: bb thread wait <id> [options]");
  expect(leaf.stdout).toMatch(
    /--timeout <duration> +Seconds, or 90s, 20m, 4h/u,
  );
  expect(leaf.stdout).toContain("exit 2 on timeout");
  const guide = await runBb(["guide", "commands", "machine"]);
  expect(guide.stdout).toContain(
    "bb machine rename <machine> <name> [options]",
  );
  expect(guide.stdout).not.toContain("bb thread spawn");
  const concepts = await runBb(["guide"]);
  expect([concepts.code, concepts.stderr]).toEqual([0, ""]);
  const unknown = await runBb(["thread", "tel", "--json"]);
  expect(unknown.code).toBe(1);
  expect(unknown.stdout).toContain('"code": "unknown_command"');
  expect(unknown.stderr).toContain("Did you mean 'tell'?");
}, 60_000);
