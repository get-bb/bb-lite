import { defineCli, cliCommand, PluginCliError } from "./src/cli.ts";
const echo = (input) => ({ exitCode: 0, stdout: JSON.stringify({ options: input.options, positionals: input.positionals }) + "\n" });
const spec = {
  name: "demo", summary: "Demo plugin commands",
  root: cliCommand({ summary: "Show the status", positionals: [{ name: "target", description: "What to show" }], options: { verbose: { type: "boolean", description: "More output", aliases: ["v"] } }, run: echo }),
  commands: {
    "add": cliCommand({ summary: "Add items", description: "Adds one or more items to the list.", aliases: ["new", "create item"],
      positionals: [{ name: "name", description: "Item name", required: true }, { name: "tags", description: "Extra tags", variadic: true }],
      options: {
        count: { type: "integer", description: "How many", default: 1 },
        kind: { type: "enum", values: ["a", "b", "c"], description: "Item kind", required: true },
        label: { type: "string", description: "Labels", repeatable: true, placeholder: "text", aliases: ["l"] },
        force: { type: "boolean", description: "Overwrite" },
        json: { type: "boolean", description: "Print JSON" },
        size: { type: "integer", description: "Sizes", repeatable: true },
      }, run: echo }),
    "item list": cliCommand({ summary: "List items", options: { json: { type: "boolean", description: "Print JSON" }, filter: { type: "string", description: "Filter text" } }, run: echo }),
    "item remove": cliCommand({ summary: "Remove an item", positionals: [{ name: "id", description: "Item id", required: true }],
      options: { json: { type: "boolean", description: "Print JSON" } },
      run: (input) => { if (input.positionals.id === "boom") throw new PluginCliError("could not remove", { code: "not_found", hint: "Check the id." }); if (input.positionals.id === "bare") throw new PluginCliError("plain failure", { exitCode: 3 }); return { exitCode: 0, stdout: input.help }; } }),
  },
};
const cli = defineCli(spec);
const noRoot = defineCli({ name: "bare", summary: "No root", commands: { go: spec.commands["item list"] } });
const cases = [
  ["demo", []], ["demo", ["--help"]], ["demo", ["-h"]], ["demo", ["item", "--help"]], ["demo", ["item"]],
  ["demo", ["add", "--help"]], ["demo", ["item", "list", "-h"]], ["demo", ["item", "remove", "--help"]],
  ["demo", ["status"]], ["demo", ["-v"]], ["demo", ["--verbose=false"]], ["demo", ["x", "y"]],
  ["demo", ["add", "n1", "t1", "t2", "--kind", "a", "-l", "x", "--label=y", "--size", "3", "--size=-4", "--force"]],
  ["demo", ["new", "n1", "--kind=b", "--count", "7"]], ["demo", ["create", "item", "n1", "--kind", "c", "--", "--help", "z"]],
  ["demo", ["add", "--kind", "a"]], ["demo", ["add", "n"]], ["demo", ["add"]], ["demo", ["add", "n", "--kind", "d"]],
  ["demo", ["add", "n", "--kind", "a", "--count", "x"]], ["demo", ["add", "n", "--kind", "a", "--count", "1.5"]],
  ["demo", ["add", "n", "--kind", "a", "--kind", "b"]], ["demo", ["add", "n", "--kind"]], ["demo", ["add", "n", "--kind", "a", "--bogus"]],
  ["demo", ["add", "n", "--kind", "a", "--bogus", "--json"]], ["demo", ["item", "list", "extra"]], ["demo", ["item", "list", "--filter", "q", "--json"]],
  ["demo", ["item", "remove", "boom"]], ["demo", ["item", "remove", "boom", "--json"]], ["demo", ["item", "remove", "bare", "--json"]],
  ["demo", ["item", "remove", "ok"]], ["demo", ["item", "remove", "--json"]], ["demo", ["add", "n", "--kind", "a", "--force=false", "--force"]],
  ["bare", []], ["bare", ["nope"]], ["bare", ["nope", "--json"]], ["bare", ["--help"]], ["bare", ["go", "--filter"]],
];
const out = [];
for (const [which, argv] of cases) {
  const result = await (which === "demo" ? cli : noRoot).run(argv, { signal: new AbortController().signal });
  out.push({ cli: which, argv, result: { exitCode: result.exitCode, stdout: result.stdout ?? "", stderr: result.stderr ?? "" } });
}
console.log(JSON.stringify({ commands: cli.commands, cases: out }, null, 2));
