import { mkdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import type { PluginRunnerApi } from "@bb/runner";
import { expect, it, vi } from "vitest";
import {
  createProject,
  createTestServer,
} from "../../../apps/server/test/helpers.js";
import runnerPart from "../runner.js";

interface CliOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}
interface Queued {
  waitingOn: { kind: string; reason?: string } | null;
}

async function limitServer() {
  const server = await createTestServer({}, "echo");
  const { hostId, dataDir } = server.ctx.config;
  const directory = join(dataDir, "repo");
  mkdirSync(directory);
  const project = await createProject(server, "echo", directory);
  const cli = async (...argv: string[]) => {
    const url = "/plugins/concurrency-limit/cli";
    const response = await server.send(url, { argv });
    return JSON.parse((await response.text()).trim()) as CliOutput;
  };
  const spawn = async (text: string) => {
    const response = await server.send("/threads", {
      projectId: project.id,
      origin: "app",
      providerId: "echo",
      input: [{ type: "text", text }],
      environment: { type: "project-default" },
      startedOnBehalfOf: null,
    });
    const { id } = (await response.json()) as { id: string };
    return id;
  };
  const waiting = (id: string, reason: string) =>
    vi.waitFor(async () =>
      expect(
        await server.read<Queued[]>(`/threads/${id}/queued-messages`),
      ).toMatchObject([{ waitingOn: { kind: "plugin", reason } }]),
    );
  const answered = (id: string, text: string) =>
    vi.waitFor(async () =>
      expect(await server.read(`/threads/${id}/output`)).toEqual({
        output: `Response to: ${text}`,
      }),
    );
  return { ...server, hostId, cli, spawn, waiting, answered };
}

it("holds new turns at the overall limit and releases them when raised", async () => {
  const server = await limitServer();
  expect(await server.cli("global", "0")).toMatchObject({
    exitCode: 0,
    stdout: "0",
  });
  const id = await server.spawn("wait for a slot");
  await server.waiting(id, "0 of 0 running on all hosts");
  expect(await server.read(`/threads/${id}/output`)).toEqual({ output: null });
  const raised = await server.cli("global", "unlimited", "--json");
  expect(JSON.parse(raised.stdout)).toEqual({ globalLimit: null });
  await server.answered(id, "wait for a slot");
});

it("applies a per-host override and reports it in status", async () => {
  const server = await limitServer();
  const { hostId } = server;
  const set = await server.cli("host", hostId, "0", "--json");
  expect(JSON.parse(set.stdout)).toMatchObject({
    id: hostId,
    override: 0,
    effectiveLimit: 0,
  });
  const id = await server.spawn("host is full");
  const { stdout } = await server.cli("status", "--json");
  const status = JSON.parse(stdout) as {
    hosts: { id: string; name: string }[];
  };
  expect(status).toMatchObject({
    globalLimit: null,
    hostOverrides: [{ hostId, limit: 0 }],
  });
  const host = status.hosts.find((entry) => entry.id === hostId);
  await server.waiting(id, `0 of 0 running on host ${host?.name}`);
  await server.cli("host", hostId, "auto");
  await server.answered(id, "host is full");
});

it("detects each machine's processors for its automatic limit", async () => {
  const server = await createTestServer();
  const asked: string[] = [];
  Object.assign(server.runner.script, {
    callOp: async ({ name }: { name: string }) => {
      asked.push(name);
      return { availableParallelism: 6 };
    },
  });
  const { hostId } = server.ctx.config;
  const cli = async (...argv: string[]) => {
    const url = "/plugins/concurrency-limit/cli";
    const response = await server.send(url, { argv });
    return JSON.parse((await response.text()).trim()) as CliOutput;
  };
  await vi.waitFor(
    async () =>
      expect(
        JSON.parse((await cli("host", hostId, "--json")).stdout),
      ).toMatchObject({
        availableParallelism: 6,
        automaticLimit: 6,
        effectiveLimit: 6,
        override: null,
      }),
    { timeout: 5_000 },
  );
  expect(asked).toContain("concurrency-limit.capacity");
  const implemented: { run: () => unknown }[] = [];
  const fake = {
    implement: (_op: unknown, run: () => unknown) => {
      implemented.push({ run });
    },
  };
  runnerPart(fake as unknown as PluginRunnerApi);
  expect(implemented[0]?.run()).toEqual({
    availableParallelism: availableParallelism(),
  });
});

it("refuses a bad limit or an unknown host", async () => {
  const server = await limitServer();
  const bad = await server.cli("global", "-1");
  expect(bad.exitCode).not.toBe(0);
  expect(bad.stderr).toContain("whole number from 0 to 10000");
  const unknown = await server.cli("host", "nope", "2");
  expect(unknown.exitCode).not.toBe(0);
  expect(unknown.stderr).toContain("Unknown host: nope");
});
