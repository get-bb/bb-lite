import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ThreadListEntry } from "@bb/domain";
import { createEchoAdapter } from "@bb/runner";
import type {
  SidebarBootstrapResponse,
  ThreadSearchResponse,
  ThreadTimelineResponse as Timeline,
} from "@bb/server-contract";
import { expect, it, onTestFinished, vi } from "vitest";
import type { ServerConfig } from "../src/config.js";
import type { ThreadRow } from "../src/db/threads.js";
import { localRunnerFor } from "../src/runners/local.js";
import { createTestServer } from "./helpers.js";
import { text } from "./thread-harness.js";
import { createProject } from "./watch.js";

type StatusChange = { status: string; runtime: object; activity: object };
type Prompt = { input: { text: string }[] };

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
  const get = async <Body>(path: string): Promise<Body> =>
    (await (await fetch(`${server.url}/api/v1${path}`)).json()) as Body;
  const nextChange = async (): Promise<StatusChange> => {
    const changed = await client.next(({ changes }) =>
      String(changes).includes("status-changed"),
    );
    return (changed.metadata as { statusChange: StatusChange }).statusChange;
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
  const path = `/threads/${id}`;
  const listed = async (): Promise<ThreadListEntry | undefined> => {
    const sidebar = await get<SidebarBootstrapResponse>("/sidebar-bootstrap");
    const entries = await get<ThreadListEntry[]>("/threads");
    const entry = entries.find((thread) => thread.id === id);
    expect(sidebar.projects[0]?.threads).toEqual([entry]);
    return entry;
  };
  expect((await nextChange()).status).toBe("starting");
  const running = await nextChange();
  expect(running).toMatchObject({ runtime: { displayStatus: "active" } });
  expect(await listed()).toMatchObject(running);
  const thread = (): ThreadRow | undefined =>
    ctx.db.get<ThreadRow>("SELECT * FROM threads WHERE id = ?", id);
  await vi.waitFor(() => expect(thread()?.activeTurnId).toBeTruthy());
  const wait = `${path}/events/wait?type=turn/completed&afterSeq=0`;
  const completed = get<{ type: string; seq: number }>(wait);

  const mode = "steer-if-active" as const;
  const json = { input: text("second release_turn"), mode };
  const sent = await api.threads[":id"].send.$post({ param: { id }, json });
  expect(await sent.json()).toMatchObject({ delivery: "sent" });
  const settled = await nextChange();
  expect(settled).toMatchObject({ runtime: { displayStatus: "idle" } });
  expect(await listed()).toMatchObject(settled);
  expect(await completed).toMatchObject({ type: "turn/completed" });

  const stored = ctx.db.all<{ type: string; data: string }>(
    "SELECT type, data FROM events WHERE thread_id = ? ORDER BY sequence",
    id,
  );
  const targets = stored
    .filter(({ type }) => type === "client/turn/requested")
    .map(({ data }) => (JSON.parse(data) as { target: object }).target);
  expect(targets).toMatchObject([{ kind: "thread-start" }, { kind: "steer" }]);
  const steered = "Steered: second release_turn";
  const idle = { status: "idle", providerThreadId: `echo-${id}` };
  expect(thread()).toMatchObject(idle);

  const { hostId } = ctx.config;
  expect(await get(`${path}?include=environment,host`)).toMatchObject({
    runtime: { displayStatus: "idle" },
    canRestoreEnvironment: false,
    environment: { path: directory, hostId, status: "ready" },
    host: { id: hostId, status: "connected", machineProviderId: null },
  });
  const first = await get<Timeline>(`${path}/timeline`);
  const said = first.rows.flatMap((row) =>
    row.kind === "conversation" ? [[row.role, row.text]] : [],
  );
  expect(said).toContainEqual(["user", "delay:5000 first"]);
  expect(said).toContainEqual(["assistant", steered]);

  const again = { input: text("third pineapple"), mode: "start" as const };
  await api.threads[":id"].send.$post({ param: { id }, json: again });
  await vi.waitFor(async () => {
    const reply = { output: "Response to: third pineapple" };
    expect(await get(`${path}/output`)).toEqual(reply);
    expect(thread()?.status).toBe("idle");
  });
  const after = `${path}/timeline?afterSequence=${first.maxSeq}`;
  const second = await get<Timeline>(after);
  expect(second.rows).toEqual([]);
  expect(second.delta?.upsertRows.length).toBeGreaterThan(0);
  const search = "/threads/search?query=third%20pine";
  const found = await get<ThreadSearchResponse>(search);
  const [hit] = found.active.results;
  expect(hit?.thread.id).toBe(id);
  expect(hit?.matches[0]?.text).toBe("third pineapple");
  const prompts = async (scope: string): Promise<string[]> => {
    const entries = await get<Prompt[]>(`${scope}/prompt-history`);
    return entries.flatMap(({ input }) => input.map((part) => part.text));
  };
  const steers = ["third pineapple", "second release_turn"];
  expect(await prompts(path)).toEqual(steers);
  expect(await prompts(`/projects/${project.id}`)).toEqual([
    "delay:5000 first",
  ]);
  expect(await get(`${path}/default-execution-options`)).toMatchObject({
    model: "echo-1",
    reasoningLevel: "medium",
    permissionMode: "auto",
  });
  const plugin = ctx.plugins.deps("probe").threads;
  const query = { projectId: project.id };
  expect(await plugin.list(query)).toEqual([await listed()]);
  const types = (await plugin.events(id, first.maxSeq)).map(({ type }) => type);
  expect(types).toContain("turn/completed");
  expect(types).not.toContain("client/thread/start");
});
