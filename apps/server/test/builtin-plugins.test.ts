import * as fs from "node:fs";
import { join } from "node:path";
import { createEchoAdapter } from "@bb/runner";
import { expect, it, onTestFinished, vi } from "vitest";
import type { ServerConfig } from "../src/config.js";
import * as interactions from "../src/db/pending-interactions.js";
import { localRunnerFor } from "../src/runners/local.js";
import { createTestServer } from "./helpers.js";
import { createThreadServer, text } from "./thread-harness.js";
import { createProject } from "./watch.js";

type Json = Record<string, unknown>;
type EventData = { item: Json; interaction: Json };

const EVENTS = `SELECT data FROM events WHERE thread_id = ? AND type = ?
  ORDER BY sequence`;

async function echoServer() {
  const localRunner = (config: ServerConfig) => {
    const local = localRunnerFor(config, [createEchoAdapter()]);
    onTestFinished(local.shutdown);
    return local.connect;
  };
  const server = await createTestServer({}, { localRunner });
  const { ctx, url } = server;
  const directory = join(ctx.config.dataDir, "repo");
  fs.mkdirSync(directory);
  const { id: projectId } = await createProject(server, "echo", directory);
  const post = async (path: string, json: unknown = {}): Promise<Json> => {
    const headers = { "content-type": "application/json" };
    const init = { method: "POST", headers, body: JSON.stringify(json) };
    return (await fetch(`${url}/api/v1${path}`, init)).json() as Promise<Json>;
  };
  const spawn = async (prompt: string): Promise<string> => {
    const environment = { type: "project-default" };
    const base = { projectId, providerId: "echo", origin: "app", environment };
    const thread = await post("/threads", { ...base, input: text(prompt) });
    return String(thread.id);
  };
  const idle = (id: string): Promise<void> =>
    vi.waitFor(() => expect(ctx.threads.get(id)?.status).toBe("idle"), 5_000);
  const pending = (id: string) =>
    vi.waitFor(() => {
      const [row] = interactions.listActiveInteractions(ctx.db, id);
      expect(row?.status).toBe("pending");
      const path = `/threads/${id}/interactions/${row.id}`;
      return { path, interaction: interactions.toPendingInteraction(row) };
    }, 5_000);
  const events = (id: string, type: string): EventData[] =>
    ctx.db
      .all<{ data: string }>(EVENTS, id, type)
      .map(({ data }) => JSON.parse(data) as EventData);
  return { ...server, directory, post, spawn, idle, pending, events };
}

it("collects secrets in a thread form and writes them to the dotenv file", async () => {
  const server = await echoServer();
  const { directory: cwd, post } = server;
  const threadId = await server.spawn("hello");
  await server.idle(threadId);
  const file = join(cwd, ".env.local");
  fs.writeFileSync(file, "OTHER=1\nAPI_KEY=old # rotate me\n");
  const client = await server.socket();
  await client.subscribe({ kind: "thread-list" });
  const names = ["API_KEY", "TOKEN"];
  const flags = ["--write-env=.env.local", "--purpose=Deploy"];
  const argv = ["request", ...names, ...flags, "--describe", "API_KEY", "Main"];
  const run = (scope: Json) =>
    post("/plugins/secrets/cli", { argv, cwd, ...scope });
  expect((await run({})).stderr).toContain("must run from a bb thread");

  const cancelled = run({ threadId });
  const changed = await client.next(({ changes }) =>
    String(changes).includes("interactions-changed"),
  );
  expect(changed.metadata).toMatchObject({ hasPendingInteraction: true });
  await post(`${(await server.pending(threadId)).path}/cancel`);
  const refusal = "Secret request cancelled (user).\n";
  expect(await cancelled).toMatchObject({ exitCode: 1, stderr: refusal });

  const command = run({ threadId });
  const { interaction, path } = await server.pending(threadId);
  const fields = [
    { name: "API_KEY", description: "Main" },
    { name: "TOKEN", description: null },
  ];
  const destination = { kind: "dotenv", path: file };
  const data = { purpose: "Deploy", destination, fields };
  const origin = { pluginId: "secrets", rendererId: "secret-request" };
  const payload = { title: "Add secrets", data };
  expect(interaction).toMatchObject({ origin, payload });
  fs.appendFileSync(file, "LATE=1\n");
  const values = { API_KEY: "s3cr3t", TOKEN: "it's" };
  await post(`${path}/respond`, { value: { values } });
  const report = { path: file, names, added: 1, updated: 1, unchanged: 0 };
  const stdout = `${JSON.stringify(report)}\n`;
  expect(await command).toEqual({ exitCode: 0, stdout, stderr: "" });
  const written = `OTHER=1\nAPI_KEY='s3cr3t' # rotate me\nLATE=1\nTOKEN="it's"\n`;
  expect(fs.readFileSync(file, "utf8")).toBe(written);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);

  const lifecycle = server.events(threadId, "system/interaction/lifecycle");
  const states = lifecycle.map((event) => event.interaction.status);
  expect(states).toEqual(["pending", "interrupted", "pending", "resolved"]);
  const detail = `${file}\n- API_KEY\n- TOKEN`;
  const description = { title: "Provided API_KEY, TOKEN", detail };
  const resolution = { kind: "plugin_submitted", description };
  expect(lifecycle.at(-1)?.interaction.resolution).toEqual(resolution);
  const row = interactions.getPendingInteraction(server.ctx.db, interaction.id);
  expect(JSON.stringify([lifecycle, row])).not.toContain("s3cr3t");
});

it("asks the user on behalf of a provider without native questions", async () => {
  const server = await echoServer();
  const option = (label: string) => ({ label, description: `Use_${label}` });
  const options = [option("Postgres"), option("SQLite")];
  const questions = [{ question: "Which_db?", header: "DB", options }];
  const input = JSON.stringify({ questions });
  const prompt = `call_tool:AskUserQuestion tool_input:${input}`;
  const threadId = await server.spawn(prompt);
  const { interaction, path } = await server.pending(threadId);
  const choices = [
    { value: "q0o0", label: "Postgres", description: "Use Postgres" },
    { value: "q0o1", label: "SQLite", description: "Use SQLite" },
  ];
  const form = { id: "q0", prompt: "Which db?", shortLabel: "DB" };
  const shown = { ...form, multiSelect: false, allowFreeText: true };
  const data = { questions: [{ ...shown, options: choices }] };
  const origin = { pluginId: "ask-user-question" };
  expect(interaction).toMatchObject({ origin, payload: { title: "DB", data } });
  const answers = { q0: { selected: ["q0o0"], freeText: "with pgbouncer" } };
  await server.post(`${path}/respond`, { value: { answers } });
  await server.idle(threadId);

  const answer = "Postgres; with pgbouncer";
  const completed = server.events(threadId, "item/completed");
  const items = completed.map(({ item }) => item);
  const call = items.find(({ type }) => type === "toolCall");
  expect(JSON.parse(String(call?.result))).toMatchObject({
    questions: [{ question: "Which db?", header: "DB" }],
    answers: { "Which db?": answer },
    annotations: { "Which db?": { notes: "with pgbouncer" } },
  });
  expect(items.at(-1)?.text).toBe("Tool called: AskUserQuestion");
  const [, settled] = server.events(threadId, "system/interaction/lifecycle");
  const description = { title: `Answered Which db? — ${answer}` };
  expect(settled.interaction).toMatchObject({ resolution: { description } });

  const dismissedId = await server.spawn(prompt);
  await server.post(`${(await server.pending(dismissedId)).path}/cancel`);
  await server.idle(dismissedId);
  const refused = server.events(dismissedId, "item/completed");
  expect(JSON.stringify(refused)).toContain("dismissed the question");
});

it("adds the custom instructions to sessions and gates the question tool", async () => {
  const server = await createThreadServer();
  const cli = (...argv: string[]) =>
    server.http("POST", "/plugins/custom-instructions/cli", { argv, cwd: "/" });
  await cli("set", "Always", "use", "pnpm");
  expect((await cli("get")).body.stdout).toBe("Always use pnpm");
  const listed = await server.http<{ plugins: Json[] }>("GET", "/plugins");
  const shown = { id: "custom-instructions", hasSettings: true };
  expect(listed.body.plugins).toContainEqual(expect.objectContaining(shown));

  await server.spawn();
  await cli("clear");
  await server.spawn({ providerId: "claude-code", model: "claude-test" });
  const [codex, claude] = server.submitted.map(({ session }) => session);
  expect(codex.instructions).toContain("BB plugins:\n\nAlways use pnpm");
  expect(JSON.stringify(codex.dynamicTools)).toContain("AskUserQuestion");
  expect(claude.instructions).not.toContain("pnpm");
  expect(JSON.stringify(claude.dynamicTools)).not.toContain("AskUserQuestion");
});
