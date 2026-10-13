import { describe, expect, it } from "vitest";
import type { CliRunner } from "../src/cli-runner.js";
import {
  CommandIndexUnavailableError,
  createCommandIndexLoader,
  mergeCommandIndex,
  parseCommandReference,
  pluginCommandIndex,
  searchCommands,
} from "../src/command-index.js";

const REFERENCE = [
  "Usage: bb status [options]",
  "Show the current project, thread, environment and server",
  "JSON (--json): {project, thread}",
  "",
  "Usage: bb thread tell <id> [message] [options]",
  "Send a message to a thread",
  "Aliases: message, send",
  "Options:",
  "  --message-file <path>      Read the message from a file (- reads stdin)",
  "  --mode <mode>              steer (default), queue or auto",
  "JSON (--json): {threadId, delivery}",
  "",
  "Usage: bb thread interactions show <interactionId> [id] [options]",
  "Show one question an agent asked",
  "",
].join("\n");

function fakeRunner(outputs: { exitCode: number; stdout: string }[]) {
  let calls = 0;
  const run: CliRunner = async () => {
    const output = outputs[Math.min(calls, outputs.length - 1)];
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return {
      exitCode: output?.exitCode ?? 1,
      stdout: output?.stdout ?? "",
      stderr: "",
      timedOut: false,
      truncated: false,
    };
  };
  return { run, calls: () => calls };
}

const noPlugins = async () => [];

describe("parseCommandReference", () => {
  it("reads each command's path, arguments, aliases, options and JSON shape", () => {
    expect(parseCommandReference(REFERENCE)).toEqual([
      {
        path: "status",
        arguments: "",
        aliases: [],
        description: "Show the current project, thread, environment and server",
        options: [],
        json: "{project, thread}",
      },
      {
        path: "thread tell",
        arguments: "<id> [message]",
        aliases: ["message", "send"],
        description: "Send a message to a thread",
        options: [
          "--message-file <path>  Read the message from a file (- reads stdin)",
          "--mode <mode>  steer (default), queue or auto",
        ],
        json: "{threadId, delivery}",
      },
      {
        path: "thread interactions show",
        arguments: "<interactionId> [id]",
        aliases: [],
        description: "Show one question an agent asked",
        options: [],
      },
    ]);
  });

  it("fails clearly on output that is not a command reference", () => {
    expect(() => parseCommandReference("bb 0.0.1\n")).toThrow(
      CommandIndexUnavailableError,
    );
  });
});

describe("pluginCommandIndex", () => {
  const search = {
    type: "op",
    kind: "read",
    doors: {
      cli: {
        path: "marketplace search",
        summary: "Search the marketplace",
        positionals: ["searchQuery"],
        aliases: ["plugin search"],
      },
    },
  };
  const contracts = [
    { members: { search, changed: { type: "event" }, plain: { type: "op" } } },
  ];

  it("takes door commands from contracts and the rest from each plugin's CLI", () => {
    const groups = [
      {
        name: "marketplace",
        summary: "Plugins from the marketplace",
        commands: [
          { name: "search", summary: "Search the marketplace" },
          { name: "plugin search", summary: "Search the marketplace" },
        ],
      },
      {
        name: "tasks",
        summary: "Track work",
        commands: [{ name: "project list", summary: "List task projects" }],
      },
      { name: "bare", summary: "A command with no listing", commands: [] },
    ];
    expect(pluginCommandIndex(contracts, groups)).toEqual([
      {
        path: "marketplace search",
        aliases: ["plugin search"],
        arguments: "<search-query>",
        description: "Search the marketplace",
        options: [],
        kind: "read",
      },
      {
        path: "tasks project list",
        aliases: [],
        arguments: "",
        description: "List task projects",
        options: [],
      },
      {
        path: "bare",
        aliases: [],
        arguments: "",
        description: "A command with no listing",
        options: [],
      },
    ]);
  });
});

describe("createCommandIndexLoader", () => {
  it("runs the CLI once for concurrent and repeated loads, then again after the cache expires", async () => {
    const runner = fakeRunner([{ exitCode: 0, stdout: REFERENCE }]);
    let time = 0;
    const load = createCommandIndexLoader({
      runCli: runner.run,
      pluginCommands: async () => [
        {
          path: "tasks list",
          aliases: [],
          arguments: "",
          description: "List tasks",
          options: [],
        },
        {
          path: "status",
          aliases: [],
          arguments: "",
          description: "A plugin cannot replace a built-in command",
          options: [],
        },
      ],
      now: () => time,
    });
    const [first, second] = await Promise.all([load(), load()]);
    expect(first).toBe(second);
    expect([...first.paths]).toEqual([
      "status",
      "thread tell",
      "thread interactions show",
      "tasks list",
    ]);
    expect(first.commands[0]?.description).toContain("current project");
    await load();
    expect(runner.calls()).toBe(1);
    time = 10 * 60 * 1000;
    await load();
    expect(runner.calls()).toBe(2);
  });

  it("fails clearly on a CLI without the reference and retries on the next load", async () => {
    const runner = fakeRunner([
      { exitCode: 1, stdout: "" },
      { exitCode: 0, stdout: REFERENCE },
    ]);
    const load = createCommandIndexLoader({
      runCli: runner.run,
      pluginCommands: noPlugins,
    });
    await expect(load()).rejects.toBeInstanceOf(CommandIndexUnavailableError);
    expect((await load()).paths.has("thread tell")).toBe(true);
  });
});

describe("searchCommands", () => {
  const index = mergeCommandIndex(parseCommandReference(REFERENCE), []);

  it("ranks by the words in the query and respects the limit", () => {
    const matches = searchCommands(index, "send a message", 1);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      usage: "bb thread tell <id> [message]",
      json: "{threadId, delivery}",
      readOnly: false,
    });
  });

  it("lists commands for an empty query and marks the read-only ones", () => {
    const matches = searchCommands(index, "", 10);
    expect(matches.map((match) => match.usage)).toEqual([
      "bb status",
      "bb thread interactions show <interactionId> [id]",
      "bb thread tell <id> [message]",
    ]);
    expect(matches.map((match) => match.readOnly)).toEqual([true, true, false]);
  });
});
