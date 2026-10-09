import { contract, createKernel, fail, op, type Caller } from "@bb/plugin";
import { doorCli } from "@bb/server-kit/doors";
import { expect, it } from "vitest";
import { z } from "zod";

const noteInput = z.object({
  projectId: z.string(),
  cwd: z.string().optional(),
  text: z.string(),
  tags: z.array(z.string()).default([]),
  cron: z.string().optional(),
  at: z.string().optional(),
  timeoutMs: z.number().optional(),
});
const notes = contract("notes", {
  create: op({
    input: noteInput,
    output: noteInput,
    kind: "write",
    doors: {
      cli: {
        path: "note create",
        aliases: ["note add"],
        summary: "Write a note",
        description: "Notes belong to a project.",
        positionals: ["text"],
        flags: {
          tags: { aliases: ["tag"], split: "," },
          timeoutMs: { aliases: ["timeout"], duration: { min: 1_000 } },
        },
        from: { projectId: "projectId" },
        constraints: [{ kind: "at-most-one", options: ["cron", "at"] }],
      },
    },
  }),
  get: op({
    input: z.object({ noteId: z.string() }),
    output: z.string(),
    doors: {
      cli: { path: "note show", summary: "Show", positionals: ["noteId"] },
    },
  }),
});

function cli() {
  const caller: Caller = {
    user: "usr_1",
    role: "owner",
    door: "cli",
    thread: null,
    via: [],
  };
  const kernel = createKernel({
    currentCaller: () => caller,
    enter: (_caller, work) => work(),
    record: () => {},
    now: () => 0,
    warn: () => {},
    changed: () => {},
  });
  const scope = kernel.scope("notes", "product");
  scope.implement(notes.create, (input) => input);
  scope.implement(notes.get, ({ noteId }) =>
    fail("not_found", `No note ${noteId}`),
  );
  const registration = doorCli(kernel, "notes", "Notes");
  const signal = new AbortController().signal;
  const context = { signal, cwd: "/repo", projectId: "proj_1" };
  return (...argv: string[]) => registration?.run(argv, context);
}

it("fills door inputs from aliases, split values and where the CLI ran", async () => {
  const run = cli();
  const made = await run(
    ..."add hello --tag a,b --tag c --timeout 90 --json".split(" "),
  );
  expect(JSON.parse(made?.stdout ?? "")).toEqual({
    projectId: "proj_1",
    cwd: "/repo",
    text: "hello",
    tags: ["a", "b", "c"],
    timeoutMs: 90_000,
  });
  const other = await run("create", "hi", "--project-id", "proj_2", "--json");
  expect(JSON.parse(other?.stdout ?? "")).toMatchObject({
    projectId: "proj_2",
  });
  const both = await run("create", "hi", "--cron", "x", "--at", "now");
  expect(both?.stderr).toContain("--cron and --at cannot be combined");
  const help = await run("create", "--help");
  expect(help?.stdout).toContain("Notes belong to a project.");
});

it("reports a refused call with its code", async () => {
  const missing = await cli()("show", "n1", "--json");
  expect(missing?.exitCode).toBe(1);
  expect(JSON.parse(missing?.stdout ?? "")).toMatchObject({
    ok: false,
    error: { code: "not_found", message: "No note n1" },
  });
});
