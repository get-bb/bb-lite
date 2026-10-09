import { sessions } from "@bb/plugin";
import { expect, it } from "vitest";
import { createThreadServer } from "../../../apps/server/test/thread-harness.js";
import { memory } from "../contract.js";

interface CliOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function memoryServer() {
  const server = await createThreadServer();
  const cli = async (argv: string[], scope: Record<string, string> = {}) => {
    const response = await fetch(`${server.url}/api/v1/plugins/memory/cli`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ argv, ...scope }),
    });
    const output = JSON.parse((await response.text()).trim()) as CliOutput;
    return { ...output, json: () => JSON.parse(output.stdout) };
  };
  return { ...server, cli };
}

const project = { projectId: "proj_1", threadId: "thr_1" };
const add = (name: string, scope: string, extra: string[] = []) => [
  "add",
  "--scope",
  scope,
  "--name",
  name,
  "--summary",
  `Summary of ${name}`,
  "--body",
  `Use pnpm vitest for ${name} checks`,
  "--reason",
  "verified while working",
  ...extra,
];

it("saves, searches, reads, updates and forgets memories through the CLI", async () => {
  const { cli } = await memoryServer();
  const saved = await cli(
    add("test-runner", "project", ["--tags", "tests,ci", "--json"]),
    project,
  );
  expect(saved.exitCode).toBe(0);
  const record = saved.json().memory;
  expect(record).toMatchObject({
    scope: "project",
    projectId: "proj_1",
    name: "test-runner",
    tags: ["tests", "ci"],
    kind: "fact",
    importance: 50,
    pinned: false,
    sourceThreadId: "thr_1",
    version: 1,
  });
  expect((await cli(add("test-runner", "project"), project)).stderr).toContain(
    'an active project memory named "test-runner" already exists',
  );
  expect((await cli(add("loose", "project"))).stderr).toContain(
    "requires a BB project context",
  );
  expect(
    (await cli(add("global-pref", "global", ["--pinned"]))).stdout,
  ).toMatch(/^Saved mem_\S+ v1 \(global\/global-pref\)\.$/u);

  const found = (
    await cli(["search", "vitest", "checks", "--json"], project)
  ).json();
  expect(found).toMatchObject({ ok: true, query: "vitest checks" });
  expect(found.memories).toHaveLength(2);
  expect(found.memories[0]).not.toHaveProperty("details");
  const globalOnly = await cli(["search", "vitest", "--json"]);
  expect(globalOnly.json().memories).toHaveLength(1);

  const got = (await cli(["get", "test-runner", "--json"], project)).json();
  expect(got).toEqual({ ok: true, memory: record });

  const conflict = await cli(
    [
      "update",
      record.id,
      "--expected-version",
      "2",
      "--reason",
      "x",
      "--importance",
      "90",
    ],
    project,
  );
  expect(conflict.stderr).toContain("version conflict");
  expect(
    (
      await cli(
        ["update", record.id, "--expected-version", "1", "--reason", "x"],
        project,
      )
    ).exitCode,
  ).not.toBe(0);
  const updated = await cli(
    [
      "update",
      record.id,
      "--expected-version",
      "1",
      "--reason",
      "raised",
      "--importance",
      "90",
      "--pinned",
      "true",
      "--json",
    ],
    project,
  );
  expect(updated.json().memory).toMatchObject({
    version: 2,
    importance: 90,
    pinned: true,
  });

  expect(
    (
      await cli(
        add("leak", "global").map((w) =>
          w === "verified while working" ? "API_KEY=abc123" : w,
        ),
      )
    ).stderr,
  ).toContain("contains a credential assignment");

  const forgot = await cli(
    [
      "forget",
      record.id,
      "--expected-version",
      "2",
      "--reason",
      "stale",
      "--json",
    ],
    project,
  );
  expect(forgot.json()).toEqual({
    ok: true,
    forgotten: { id: record.id, version: 3 },
  });
  const history = (await cli(["history", record.id, "--json"], project)).json();
  expect(history.history.map((h: { action: string }) => h.action)).toEqual([
    "forget",
    "update",
    "create",
  ]);
  const listed = (await cli(["list", "--json"], project)).json();
  expect(listed).toMatchObject({ ok: true, scope: "all", total: 1 });
});

it("adds the memory index to a project thread's instructions and edits from settings", async () => {
  const { cli, ctx } = await memoryServer();
  const context = {
    threadId: "thr_1",
    projectId: "proj_1",
    hostId: null,
    providerId: "echo",
  };
  const empty = await ctx.kernel.call(sessions.instructions, context);
  expect(empty.find((s) => s.source === "memory")?.text).toContain(
    "No memories are stored yet.",
  );
  const saved = (
    await cli(add("deploy", "project", ["--json"]), project)
  ).json();
  const sections = await ctx.kernel.call(sessions.instructions, context);
  const index = sections.find((s) => s.source === "memory")?.text ?? "";
  expect(index).toContain("Memory index");
  expect(index).toContain(
    `- ${saved.memory.id} [project/fact] deploy: Summary of deploy`,
  );

  const { memories } = await ctx.kernel.call(memory.list, {});
  expect(memories).toHaveLength(1);
  const edited = await ctx.kernel.call(memory.update, {
    memoryId: saved.memory.id,
    expectedVersion: 1,
    summary: "Edited summary",
    details: "Edited details",
    kind: "procedure",
    tags: ["ops"],
    importance: 70,
    pinned: false,
  });
  expect(edited.memory).toMatchObject({
    version: 2,
    kind: "procedure",
    writeReason: "Edited in Memory settings",
  });
  await expect(
    ctx.kernel.call(memory.delete, {
      memoryId: saved.memory.id,
      expectedVersion: 1,
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  await expect(
    ctx.kernel.call(memory.delete, {
      memoryId: "mem_none",
      expectedVersion: 1,
    }),
  ).rejects.toMatchObject({ code: "not_found" });
  await ctx.kernel.call(memory.delete, {
    memoryId: saved.memory.id,
    expectedVersion: 2,
  });
  expect((await ctx.kernel.call(memory.list, {})).memories).toEqual([]);
});

it("checks flag ranges, comma-split tags and update fields while parsing", async () => {
  const { cli } = await memoryServer();
  const saved = await cli(
    add("split", "project", ["--tag", "a, b", "--tag", "c", "--json"]),
    project,
  );
  expect(saved.json().memory.tags).toEqual(["a", "b", "c"]);
  const tooMany = await cli(["catalog", "--limit", "500", "--json"], project);
  expect(tooMany.exitCode).not.toBe(0);
  expect(tooMany.stdout + tooMany.stderr).toContain("from 1 to 100");
  const nothing = await cli(
    [
      "update",
      saved.json().memory.id,
      "--expected-version",
      "1",
      "--reason",
      "x",
    ],
    project,
  );
  expect(nothing.exitCode).not.toBe(0);
  expect(nothing.stdout + nothing.stderr).toContain(
    "one of --summary, --details, --kind, --tag, --importance, --pinned",
  );
});
