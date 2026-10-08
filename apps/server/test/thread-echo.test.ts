import type { ThreadListEntry } from "@bb/domain";
import type {
  SidebarBootstrapResponse,
  ThreadTimelineResponse as Timeline,
} from "@bb/server-contract";
import { threads } from "@bb/plugin";
import { expect, it, vi } from "vitest";
import type { ThreadRow } from "@bb/server-kit/db/threads";
import { createEchoServer } from "./helpers.js";
import { text } from "./thread-harness.js";

type Prompt = { input: { text: string }[] };

it("runs an echo thread on the real local runner and steers it", async () => {
  const server = await createEchoServer();
  const { api, ctx, directory, project, read: get } = server;
  const environment = { type: "project-default" } as const;
  const origin = { projectId: project.id, origin: "app" } as const;
  const first = { providerId: "echo", input: text("delay:5000 first") };
  const json = { ...origin, ...first, environment, startedOnBehalfOf: null };
  const { id } = await (await api.threads.$post({ json })).json();
  const path = `/threads/${id}`;
  const row = () =>
    ctx.db.get<ThreadRow>("SELECT * FROM threads WHERE id = ?", id);
  const listed = async (): Promise<ThreadListEntry | undefined> => {
    const sidebar = await get<SidebarBootstrapResponse>("/sidebar-bootstrap");
    const entries = await get<ThreadListEntry[]>("/threads");
    const entry = entries.find((thread) => thread.id === id);
    expect(sidebar.projects[0]?.threads).toEqual([entry]);
    expect(sidebar.personalProject).toMatchObject({ kind: "personal" });
    return entry;
  };
  await vi.waitFor(() => expect(row()?.activeTurnId).toBeTruthy());
  const running = { runtime: { displayStatus: "active" } };
  expect(await listed()).toMatchObject(running);
  const wait = `${path}/events/wait?type=turn/completed&afterSeq=0`;
  expect((await server.request(`${wait}&waitMs=20`)).status).toBe(204);
  const completed = get<{ type: string; seq: number }>(wait);

  const steer = { input: text("second release_turn"), mode: "steer" as const };
  const sent = await api.threads[":id"].send.$post({
    param: { id },
    json: steer,
  });
  expect(await sent.json()).toMatchObject({ delivery: "sent" });
  expect(await completed).toMatchObject({ type: "turn/completed" });
  await vi.waitFor(() => expect(row()?.status).toBe("idle"));
  const { hostId } = ctx.config;
  expect(await get(`${path}?include=environment,host`)).toMatchObject({
    runtime: { displayStatus: "idle" },
    environment: { path: directory, hostId, status: "ready" },
    host: { id: hostId, status: "connected", machineProviderId: null },
  });
  const timeline = await get<Timeline>(`${path}/timeline`);
  const said = timeline.rows.flatMap((row) =>
    row.kind === "conversation" ? [[row.role, row.text]] : [],
  );
  expect(said).toContainEqual(["user", "delay:5000 first"]);
  expect(said).toContainEqual(["assistant", "Steered: second release_turn"]);

  const again = { input: text("third pineapple"), mode: "start" as const };
  await api.threads[":id"].send.$post({ param: { id }, json: again });
  await vi.waitFor(async () => {
    const reply = { output: "Response to: third pineapple" };
    expect(await get(`${path}/output`)).toEqual(reply);
    expect(row()?.status).toBe("idle");
  });
  const prompts = async (scope: string) => {
    const entries = await get<Prompt[]>(`${scope}/prompt-history`);
    return entries.flatMap(({ input }) => input.map((part) => part.text));
  };
  const steers = ["third pineapple", "second release_turn"];
  expect(await prompts(path)).toEqual(steers);
  const started = ["delay:5000 first"];
  expect(await prompts(`/projects/${project.id}`)).toEqual(started);
  const plugin = ctx.kernel.scope("probe", "product");
  const query = { projectId: project.id };
  expect(await plugin.call(threads.list, query)).toEqual([await listed()]);
  const after = { threadId: id, after: timeline.maxSeq };
  const recorded = await plugin.call(threads.events, after);
  const types = recorded.map(({ type }) => type);
  expect(types).toContain("turn/completed");
  expect(types).not.toContain("client/thread/start");
});
