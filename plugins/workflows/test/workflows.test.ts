import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { plugins } from "@bb/plugin";
import { runAs } from "@bb/server-kit/auth/actor";
import { expect, it, vi } from "vitest";
import {
  createProject,
  createTestServer,
} from "../../../apps/server/test/helpers.js";

interface CliOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const SCRIPT = `export const meta = {
  name: "two-steps",
  description: "Draft, then review the draft",
  phases: [{ title: "Draft" }, { title: "Review" }],
};
phase("Draft");
const first = await agent(\`draft \${args.topic}\`, { label: "Draft" });
phase("Review");
const second = await agent(\`review \${first}\`, { label: "Review" });
return { first, second };
`;

const FIRST = "Response to: draft tests";
const SECOND = `Response to: review ${FIRST}`;

async function workflowServer(extra: string[] = []) {
  const server = await createTestServer({}, "echo", ":memory:", [
    "workflows",
    ...extra,
  ]);
  const { hostId, dataDir } = server.ctx.config;
  const directory = join(dataDir, "repo");
  mkdirSync(directory);
  const project = await createProject(server, "echo", directory);
  const cli = async (plugin: string, ...argv: string[]) => {
    const response = await server.send(`/plugins/${plugin}/cli`, { argv });
    return JSON.parse((await response.text()).trim()) as CliOutput;
  };
  const response = await server.send("/threads", {
    projectId: project.id,
    origin: "app",
    providerId: "echo",
    input: [{ type: "text", text: "plan" }],
    environment: { type: "project-default" },
    startedOnBehalfOf: null,
  });
  const { id: threadId } = (await response.json()) as { id: string };
  await vi.waitFor(async () =>
    expect(await server.read(`/threads/${threadId}/output`)).toEqual({
      output: "Response to: plan",
    }),
  );
  const start = async (input: object) => {
    const actor = {
      userId: "usr_owner",
      role: "owner" as const,
      agentThreadId: threadId,
    };
    const result = await runAs(actor, () =>
      server.ctx.kernel.call(plugins.callAgentTool, {
        name: "bb_workflow_run",
        input,
        context: {
          threadId,
          projectId: project.id,
          hostId,
          providerId: "echo",
        },
      }),
    );
    const item = result.contentItems[0];
    const text = item?.type === "inputText" ? item.text : "";
    return { success: result.success, text };
  };
  const status = async (runId: string) =>
    JSON.parse((await cli("workflows", "status", runId, "--json")).stdout);
  const workers = () =>
    server.ctx.db.all<{ id: string }>(
      "SELECT id FROM threads WHERE origin_plugin_id = 'workflows'",
    );
  return { ...server, cli, start, status, workers };
}

it("runs a two-step workflow to completion and reads back status and history", async () => {
  const server = await workflowServer();
  const started = await server.start({
    script: SCRIPT,
    args: { topic: "tests" },
  });
  expect(started.success).toBe(true);
  const { runId, previewDirective } = JSON.parse(started.text);
  expect(previewDirective).toBe(`::workflow-preview{run="${runId}"}`);
  await vi.waitFor(async () =>
    expect(await server.status(runId)).toMatchObject({
      name: "two-steps",
      status: "succeeded",
      phase: "Review",
      result: { first: FIRST, second: SECOND },
      calls: { succeeded: 2 },
    }),
  );
  const history = await server.cli(
    "workflows",
    "history",
    runId,
    "--cursor",
    "1",
    "--limit",
    "5",
  );
  const records = history.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records).toMatchObject([
    { type: "run", id: runId, status: "succeeded" },
    {
      type: "call",
      index: 1,
      label: "Review",
      phase: "Review",
      result: SECOND,
    },
    { type: "page", nextCursor: null },
  ]);
  expect(server.workers()).toHaveLength(2);
});

it("rejects a script without metadata", async () => {
  const server = await workflowServer();
  const started = await server.start({ script: "return 1;" });
  expect(started.success).toBe(false);
  expect(started.text).toContain("export const meta");
});

it("resumes a run in progress after the plugin is reloaded", async () => {
  const server = await workflowServer(["concurrency-limit"]);
  expect(await server.cli("concurrency-limit", "global", "0")).toMatchObject({
    exitCode: 0,
  });
  const started = await server.start({
    script: SCRIPT,
    args: { topic: "tests" },
  });
  const { runId } = JSON.parse(started.text);
  await vi.waitFor(() => expect(server.workers()).toHaveLength(1));
  expect(await server.status(runId)).toMatchObject({
    status: "running",
    calls: { running: 1 },
  });
  await server.ctx.kernel.call(plugins.reload, { id: "workflows" });
  await server.cli("concurrency-limit", "global", "unlimited");
  await vi.waitFor(async () =>
    expect(await server.status(runId)).toMatchObject({
      status: "succeeded",
      result: { first: FIRST, second: SECOND },
    }),
  );
  expect(server.workers()).toHaveLength(2);
});
