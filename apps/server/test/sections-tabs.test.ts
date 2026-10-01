import {
  threadSectionMutationResponseSchema as mutationSchema,
  threadSectionSchema,
  threadTabsResponseSchema,
  type UpdateThreadTabsRequest,
} from "@bb/server-contract";
import { expect, it } from "vitest";
import { createTestServer } from "./helpers.js";
import { insertThread, watchChanges } from "./watch.js";

it("keeps section names unique and un-sections threads on delete", async () => {
  const server = await createTestServer();
  const { api, ctx } = server;
  const changed = await watchChanges(server);
  const sections = api["thread-sections"];
  const create = (name: string) => sections.$post({ json: { name } });
  const later = threadSectionSchema.parse(
    await (await create(" Later ")).json(),
  );
  expect(later.name).toBe("Later");
  await changed("project", "threads-changed");
  expect((await create("Later")).status).toBe(409);
  const soon = threadSectionSchema.parse(await (await create("Soon")).json());
  await changed("project", "threads-changed");
  const rename = (id: string, name: string) =>
    sections.$patch({ json: { id, name } });
  expect((await rename(soon.id, "Later")).status).toBe(409);
  expect((await rename("sec_gone", "Never")).status).toBe(404);
  const renamed = await (await rename(later.id, "Someday")).json();
  const unchangedThreads = { name: "Someday", updatedThreadCount: 0 };
  expect(mutationSchema.parse(renamed)).toMatchObject(unchangedThreads);
  await changed("project", "threads-changed");
  insertThread(server, "thr_1");
  ctx.db.run("UPDATE threads SET section_id = ?", later.id);
  const removed = await sections.$delete({ json: { id: later.id } });
  expect(mutationSchema.parse(await removed.json()).updatedThreadCount).toBe(1);
  const thread = await changed("thread", "title-changed");
  expect(thread).toMatchObject({ id: "thr_1" });
  const unsectioned = "SELECT id FROM threads WHERE section_id IS NULL";
  expect(ctx.db.all(unsectioned)).toHaveLength(1);
  const names = (await (await sections.$get()).json()).map(({ name }) => name);
  expect(names).toEqual(["Soon"]);
});

it("replaces thread tabs only at the expected revision", async () => {
  const server = await createTestServer();
  const changed = await watchChanges(server);
  insertThread(server, "thr_1");
  const tabs = server.api.threads[":id"].tabs;
  const param = { id: "thr_1" };
  const stored = async () =>
    threadTabsResponseSchema.parse(await (await tabs.$get({ param })).json());
  expect(await stored()).toEqual({ revision: 0, tabs: [] });
  const file = { path: "/etc/hosts", lineRange: null, hostId: null };
  const owner = { environmentId: null, threadId: "thr_1", id: "t2" };
  const preview = { ...file, ...owner, kind: "host-file-preview" } as const;
  const diff = { id: "t1", kind: "git-diff" } as const;
  type Tabs = UpdateThreadTabsRequest["tabs"];
  const replace = (expectedRevision: number, list: Tabs) =>
    tabs.$put({ param, json: { expectedRevision, tabs: list } });
  const saved = await replace(0, [diff, preview]);
  const wire: unknown = await saved.json();
  expect(JSON.stringify(wire)).not.toContain("hostId");
  const parsed = threadTabsResponseSchema.parse(wire);
  expect(parsed).toEqual({ revision: 1, tabs: [diff, preview] });
  expect(await changed("thread", "tabs-changed")).toMatchObject(param);
  const conflict = await replace(0, []);
  const details = { currentRevision: 1 };
  const refusal = { code: "thread_tabs_conflict", details };
  expect(await conflict.json()).toMatchObject(refusal);
  expect((await stored()).tabs).toHaveLength(2);
  expect((await tabs.$get({ param: { id: "thr_gone" } })).status).toBe(404);
});
