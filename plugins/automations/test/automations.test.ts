import { expect, it, vi } from "vitest";
import { createThreadServer } from "../../../apps/server/test/thread-harness.js";
import type { Automation, Run } from "../contract.js";

interface CliOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const MINUTE = 60_000;
const WAIT = { timeout: 4000 };

async function automationsServer() {
  const server = await createThreadServer();
  const cli = async (line: string) => {
    const words =
      line.replace(/^automation /u, "").match(/'[^']*'|\S+/gu) ?? [];
    const argv = words.map((word) => word.replace(/^'|'$/gu, ""));
    const response = await fetch(
      `${server.url}/api/v1/plugins/automations/cli`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ argv }),
      },
    );
    const output = JSON.parse(await response.text()) as CliOutput;
    await server.settle();
    return { ...output, json: <Shape>() => JSON.parse(output.stdout) as Shape };
  };
  const create = async (flags: string) => {
    const result = await cli(
      `automation create --project proj_1 --name Nightly --prompt 'Check the build' --provider codex --model gpt-test ${flags} --json`,
    );
    expect(result.exitCode, result.stderr).toBe(0);
    return result.json<Automation>();
  };
  const runs = async (automationId: string) =>
    (
      await cli(`automation runs ${automationId} --project proj_1 --json`)
    ).json<{ runs: Run[] }>().runs;
  const threadsOfPlugin = () =>
    server.rows<{ id: string; title: string }>(
      "SELECT id, title FROM threads WHERE origin_plugin_id = 'automations'",
    );
  return { ...server, cli, create, runs, threadsOfPlugin };
}

it("fires a one-shot automation once, creating a thread and recording the run", async () => {
  const server = await automationsServer();
  const created = await server.create("--in 5m");
  expect(created).toMatchObject({
    name: "Nightly",
    enabled: true,
    origin: "human",
    trigger: { triggerType: "once" },
    nextRunAt: server.clock.now + 5 * MINUTE,
    execution: { mode: "agent", reasoningLevel: "medium" },
  });

  server.clock.now += 6 * MINUTE;
  await vi.waitFor(
    () => expect(server.threadsOfPlugin()).toHaveLength(1),
    WAIT,
  );
  const [thread] = server.threadsOfPlugin();
  expect(thread?.title).toBe("Nightly");
  const prompt = JSON.stringify(server.submitted[0]?.input);
  expect(prompt).toContain(`[bb automation due:${created.id}]`);
  expect(prompt).toContain("Check the build");

  const nested = await fetch(`${server.url}/api/v1/plugins/automations/cli`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      argv: [
        "create",
        "--project",
        "proj_1",
        "--name",
        "N",
        "--in",
        "5m",
      ].concat(["--prompt", "p", "--provider", "codex", "--model", "m"]),
      threadId: thread?.id,
    }),
  });
  expect(JSON.stringify(await nested.json())).toContain("cannot create");

  const [run] = await server.runs(created.id);
  expect(run).toMatchObject({
    status: "running",
    trigger: "schedule",
    threadId: thread?.id,
  });
  await server.runTurn(thread?.id ?? "", "turn-1");
  await vi.waitFor(async () =>
    expect((await server.runs(created.id))[0]?.status).toBe("succeeded"),
  );

  const after = (
    await server.cli(`automation show ${created.id} --project proj_1 --json`)
  ).json<Automation>();
  expect(after).toMatchObject({
    enabled: false,
    nextRunAt: null,
    runCount: 1,
    lastRunStatus: "succeeded",
    lastRunThreadId: thread?.id,
  });
  server.clock.now += 60 * MINUTE;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(server.threadsOfPlugin()).toHaveLength(1);
});

it("reschedules a recurring automation and honours pause, resume and delete", async () => {
  const server = await automationsServer();
  const created = await server.create("--cron '0 * * * *' --timezone UTC");
  const firstDue = created.nextRunAt ?? 0;
  expect(firstDue).toBeGreaterThan(server.clock.now);

  const paused = await server.cli(
    `automation pause ${created.id} --project proj_1 --json`,
  );
  expect(paused.json<Automation>()).toMatchObject({
    enabled: false,
    nextRunAt: null,
  });
  server.clock.now = firstDue + MINUTE;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(server.threadsOfPlugin()).toHaveLength(0);

  const resumed = (
    await server.cli(`automation resume ${created.id} --project proj_1 --json`)
  ).json<Automation>();
  expect(resumed.enabled).toBe(true);
  server.clock.now = (resumed.nextRunAt ?? 0) + 1;
  await vi.waitFor(
    () => expect(server.threadsOfPlugin()).toHaveLength(1),
    WAIT,
  );
  const shown = (
    await server.cli(`automation show ${created.id} --project proj_1 --json`)
  ).json<Automation>();
  expect(shown.enabled).toBe(true);
  expect(shown.nextRunAt).toBe((resumed.nextRunAt ?? 0) + 60 * MINUTE);

  const list = await server.cli("automation list --project proj_1");
  expect(list.stdout).toContain("0 * * * * (UTC)");

  const refused = await server.cli(
    `automation delete ${created.id} --project proj_1`,
  );
  expect(refused.exitCode).not.toBe(0);
  const deleted = await server.cli(
    `automation delete ${created.id} --project proj_1 --yes --json`,
  );
  expect(deleted.json()).toEqual({ ok: true, id: created.id });
  expect(
    (await server.cli("automation list --project proj_1 --json")).json(),
  ).toEqual([]);
});

it("runs on demand, reuses an idempotency key and re-prompts a target thread", async () => {
  const server = await automationsServer();
  const targetId = await server.spawn();
  const created = await server.create(
    `--in 1d --target-thread ${targetId} --disabled`,
  );
  expect(created).toMatchObject({ enabled: false, nextRunAt: null });

  const first = await server.cli(
    `automation run ${created.id} --project proj_1 --idempotency-key k1 --json`,
  );
  const again = await server.cli(
    `automation run ${created.id} --project proj_1 --idempotency-key k1 --json`,
  );
  const run = first.json<{ run: Run }>().run;
  expect(again.json<{ run: Run }>().run.id).toBe(run.id);
  await vi.waitFor(async () =>
    expect((await server.runs(created.id))[0]?.threadId).toBe(targetId),
  );
  expect(server.threadsOfPlugin()).toHaveLength(0);
  expect(await server.runs(created.id)).toHaveLength(1);

  const script = await server.cli(
    "automation create --project proj_1 --name S --in 5m --script 'echo hi'",
  );
  expect(script.exitCode).not.toBe(0);
});
