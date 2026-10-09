import { expect, it } from "vitest";
import { cliCommand, defineCli } from "../src/index.js";

const signal = new AbortController().signal;
const cli = defineCli({
  name: "timer",
  summary: "Timers",
  description: "Timers that fire once or on a schedule.",
  commands: {
    create: cliCommand({
      summary: "Create a timer",
      options: {
        cron: { type: "string", description: "Cron expression" },
        at: { type: "string", description: "One time" },
        timezone: { type: "string", description: "Timezone", aliases: ["tz"] },
        timeout: {
          type: "duration",
          description: "How long a run may take",
          min: 1_000,
          max: 120_000,
          units: ["s", "ms"],
        },
        retries: { type: "integer", description: "Retries", min: 0, max: 5 },
        tag: {
          type: "string",
          description: "Tags",
          repeatable: true,
          split: ",",
        },
        json: { type: "boolean", description: "JSON" },
      },
      constraints: [
        { kind: "exactly-one", options: ["cron", "at"] },
        { kind: "requires", option: "timezone", needs: ["cron"] },
      ],
      passthrough: true,
      unexpectedPositionalHint: "Quote the cron expression.",
      run: ({ options, passthrough }) => ({
        exitCode: 0,
        stdout: JSON.stringify({ ...options, passthrough }),
      }),
    }),
  },
});

const run = async (...argv: string[]) => {
  const result = await cli.run(["create", ...argv], { signal });
  return { ...result, parsed: JSON.parse(result.stdout || "null") };
};

it("parses durations, ranges, split values and what follows --", async () => {
  const { parsed } = await run(
    ..."--cron x --tz UTC --timeout 90 --retries 2".split(" "),
    ..."--tag a,b --tag c -- run --fast".split(" "),
  );
  expect(parsed).toMatchObject({
    cron: "x",
    timezone: "UTC",
    timeout: 90_000,
    retries: 2,
    tag: ["a", "b", "c"],
    passthrough: ["run", "--fast"],
  });
  expect((await run("--at now", "--timeout", "1500")).exitCode).toBe(1);
  const milliseconds = await run("--at", "now", "--timeout", "1500");
  expect(milliseconds.parsed.timeout).toBe(1500);
  expect((await run("--at", "now", "--timeout", "2m")).parsed.timeout).toBe(
    120_000,
  );
  const slow = await run("--at", "now", "--timeout", "3m");
  expect(slow.stderr).toContain("expected a duration with a unit");
  const many = await run("--at", "now", "--retries", "9");
  expect(many.stderr).toContain("an integer from 0 to 5");
});

it("enforces how options relate and explains a stray word", async () => {
  expect((await run()).stderr).toContain("one of --cron, --at");
  const both = await run("--cron", "x", "--at", "now");
  expect(both.stderr).toContain("--cron and --at cannot be combined");
  expect(both.stderr).toContain("Pass exactly one of: --cron, --at");
  const zone = await run("--at", "now", "--timezone", "UTC");
  expect(zone.stderr).toContain("--timezone requires --cron");
  const stray = await run("--cron", "0", "9");
  expect(stray.stderr).toContain("unexpected argument '9'");
  expect(stray.stderr).toContain("Quote the cron expression.");
  const help = await cli.run(["--help"], { signal });
  expect(help.stdout).toContain("Timers that fire once or on a schedule.");
});

it("counts a given positional toward an exactly-one constraint", async () => {
  const pull = defineCli({
    name: "docs",
    summary: "Docs",
    commands: {
      pull: cliCommand({
        summary: "Pull",
        positionals: [{ name: "path" }],
        options: { all: { type: "boolean", description: "All" } },
        constraints: [{ kind: "exactly-one", options: ["path", "all"] }],
        run: ({ positionals, options }) => ({
          exitCode: 0,
          stdout: JSON.stringify({ positionals, options }),
        }),
      }),
    },
  });
  const ok = await pull.run(["pull", "notes"], { signal });
  expect(ok.exitCode).toBe(0);
  expect((await pull.run(["pull", "--all"], { signal })).exitCode).toBe(0);
  const both = await pull.run(["pull", "notes", "--all"], { signal });
  expect(both.stderr).toContain("cannot be combined");
  const none = await pull.run(["pull"], { signal });
  expect(none.stderr).toContain("missing required options");
});
