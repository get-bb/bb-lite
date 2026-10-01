import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createEchoAdapter } from "@bb/runner";
import { expect, it, onTestFinished, vi } from "vitest";
import type { ServerConfig } from "../src/config.js";
import type { ThreadRow } from "../src/db/threads.js";
import { localRunnerFor } from "../src/runners/local.js";
import { createTestServer } from "./helpers.js";
import { text } from "./thread-harness.js";
import { createProject } from "./watch.js";

type StatusMetadata = { statusChange?: { status: string } };

it("runs an echo thread on the real local runner and steers it", async () => {
  const localRunner = (config: ServerConfig) => {
    const local = localRunnerFor(config, [createEchoAdapter()]);
    onTestFinished(local.shutdown);
    return local.connect;
  };
  const server = await createTestServer({}, { localRunner });
  const { api, ctx } = server;
  const directory = join(ctx.config.dataDir, "repo");
  mkdirSync(directory);
  const project = await createProject(server, "echo", directory);
  const client = await server.socket();
  await client.subscribe({ kind: "thread-list" });
  const nextStatus = async (): Promise<string | undefined> => {
    const changed = await client.next(({ changes }) =>
      String(changes).includes("status-changed"),
    );
    return (changed.metadata as StatusMetadata).statusChange?.status;
  };

  const created = await api.threads.$post({
    json: {
      projectId: project.id,
      origin: "app",
      providerId: "echo",
      input: text("delay:5000 first"),
      environment: { type: "project-default" },
      startedOnBehalfOf: null,
      originKind: null,
    },
  });
  const { id } = await created.json();
  const started = [await nextStatus(), await nextStatus()];
  expect(started).toEqual(["starting", "active"]);
  const thread = (): ThreadRow | undefined =>
    ctx.db.get<ThreadRow>("SELECT * FROM threads WHERE id = ?", id);
  await vi.waitFor(() => expect(thread()?.activeTurnId).toBeTruthy());

  const mode = "steer-if-active" as const;
  const json = { input: text("second release_turn"), mode };
  const sent = await api.threads[":id"].send.$post({ param: { id }, json });
  expect(await sent.json()).toMatchObject({ delivery: "sent" });
  expect(await nextStatus()).toBe("idle");

  const stored = ctx.db.all<{ type: string; data: string }>(
    "SELECT type, data FROM events WHERE thread_id = ? ORDER BY sequence",
    id,
  );
  const targets = stored
    .filter(({ type }) => type === "client/turn/requested")
    .map(({ data }) => (JSON.parse(data) as { target: object }).target);
  expect(targets).toMatchObject([{ kind: "thread-start" }, { kind: "steer" }]);
  const turn = ["turn/started", "item/completed", "turn/completed"];
  const types = stored.map(({ type }) => type);
  expect(types).toEqual(expect.arrayContaining(turn));
  const steered = "Steered: second release_turn";
  expect(stored.some(({ data }) => data.includes(steered))).toBe(true);
  const settled = { status: "idle", providerThreadId: `echo-${id}` };
  expect(thread()).toMatchObject(settled);
});
