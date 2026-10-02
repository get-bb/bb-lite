import { PERSONAL_PROJECT_ID } from "@bb/domain";
import { uploadedPromptAttachmentSchema } from "@bb/server-contract";
import { expect, it } from "vitest";
import { insertHost } from "../src/db/hosts.js";
import {
  createProject,
  createTestServer,
  insertThread,
  watchChanges,
} from "./helpers.js";

const personal = { id: PERSONAL_PROJECT_ID };

it("finds or creates projects by host and path, in creation order", async () => {
  const server = await createTestServer();
  const { api, ctx } = server;
  const changed = await watchChanges(server);
  const alpha = await createProject(server, "alpha", "/repos/alpha/");
  const source = { hostId: ctx.config.hostId, path: "/repos/alpha" };
  const sources = [{ ...source, type: "local_path", isDefault: true }];
  expect(alpha).toMatchObject({ gitRemoteUrl: null, sources });
  await changed("project", "project-created", "project-sources-changed");
  const again = await createProject(server, "again", "/repos/alpha");
  expect(again.id).toBe(alpha.id);
  const beta = await createProject(server, "beta");
  const listed = await (await api.projects.$get({ query: {} })).json();
  expect(listed.map((project) => project.name)).toEqual(["alpha", "beta"]);
  const param = { id: beta.id };
  const json = { name: "beta two" };
  const renamed = await api.projects[":id"].$patch({ param, json });
  expect(await renamed.json()).toMatchObject({ ...param, ...json });
  await changed("project", "project-updated");
});

it("protects the personal project and deletes others entirely", async () => {
  const server = await createTestServer();
  const { api, ctx } = server;
  const changed = await watchChanges(server);
  const { id } = await createProject(server, "alpha");
  const query = { includePersonal: "true", include: "threads" } as const;
  const [first, second] = await (await api.projects.$get({ query })).json();
  const empty = { threads: [], defaultExecutionOptions: null, sources: [] };
  expect(first).toMatchObject({ ...personal, name: "Personal", ...empty });
  expect(second).toMatchObject({ name: "alpha", threads: [] });
  const param = personal;
  const { hostId } = ctx.config;
  const local = { type: "local_path", hostId, path: "/home/me" } as const;
  const refusals = await Promise.all([
    api.projects[":id"].$patch({ param, json: { name: "Mine" } }),
    api.projects[":id"].$delete({ param }),
    api.projects[":id"].sources.$post({ param, json: local }),
  ]);
  const statuses = refusals.map((response) => response.status).join();
  expect(statuses).toBe("404,409,404");
  insertThread(server, "thr_1", id);
  const deleted = await api.projects[":id"].$delete({ param: { id } });
  expect(await deleted.json()).toEqual({ ok: true });
  await changed("project", "project-deleted");
  const thread = await changed("thread", "thread-deleted");
  expect(thread).toMatchObject({ id: "thr_1" });
  const rows = "SELECT id FROM threads UNION SELECT id FROM project_sources";
  expect(ctx.db.all(rows)).toEqual([]);
});

it("keeps one source per machine and always a default", async () => {
  const server = await createTestServer();
  const { api, ctx } = server;
  const changed = await watchChanges(server);
  const project = await createProject(server, "alpha");
  insertHost(ctx.db, { id: "host_b", name: "b", phase: "active" });
  const param = { id: project.id };
  const add = (hostId: string, type: "local_path" | "clone" = "local_path") => {
    const path = "/srv/a";
    const json = type === "clone" ? { type, hostId } : { type, hostId, path };
    return api.projects[":id"].sources.$post({ param, json });
  };
  const remote = await (await add("host_b")).json();
  expect(remote).toMatchObject({ hostId: "host_b", isDefault: false });
  await changed("project", "project-sources-changed");
  const refused = [add("host_b"), add("host_c"), add("host_c", "clone")];
  const statuses = (await Promise.all(refused)).map(({ status }) => status);
  expect(statuses.join()).toBe("409,404,400");
  const source = api.projects[":id"].sources[":sourceId"];
  const target = { param: { ...param, sourceId: remote.id } };
  const json = { type: "local_path", isDefault: true, path: "/b/" } as const;
  const promoted = await (await source.$patch({ ...target, json })).json();
  expect(promoted).toMatchObject({ isDefault: true, path: "/b" });
  await changed("project", "project-sources-changed");
  expect((await source.$delete(target)).status).toBe(200);
  await changed("project", "project-sources-changed");
  const kept = await (await api.projects[":id"].$get({ param })).json();
  const [local] = kept.sources;
  expect(local).toMatchObject({ hostId: ctx.config.hostId, isDefault: true });
  const last = { param: { ...param, sourceId: String(local?.id) } };
  expect((await source.$delete(last)).status).toBe(409);
});

it("stores attachments and serves them with ranges", async () => {
  const server = await createTestServer();
  const project = await createProject(server, "alpha");
  const base = `${server.url}/api/v1/projects`;
  const upload = async (file: File) => {
    const body = new FormData();
    body.set("file", file);
    const init = { method: "POST", body };
    const response = await fetch(`${base}/${project.id}/attachments`, init);
    const uploaded: unknown = await response.json();
    return { status: response.status, uploaded };
  };
  const text = { type: "text/plain" };
  const stored = await upload(new File(["0123456789"], "my notes.txt", text));
  const attachment = uploadedPromptAttachmentSchema.parse(stored.uploaded);
  const path = expect.stringMatching(/^my-notes-17\d{11}-[0-9a-f]{6}\.txt$/u);
  const file = { type: "localFile", name: "my notes.txt", sizeBytes: 10 };
  expect(attachment).toMatchObject({ ...file, mimeType: "text/plain", path });
  const { id } = project;
  const read = async (range?: string, name = attachment.path, from = id) => {
    const target = `${base}/${from}/attachments/content?path=${name}`;
    const headers: Record<string, string> = range ? { range } : {};
    const response = await fetch(target, { headers });
    const { status } = response;
    const span = response.headers.get("content-range");
    return [status, span, status < 300 ? await response.text() : ""].join("|");
  };
  expect(await read()).toBe("200||0123456789");
  expect(await read("bytes=2-5")).toBe("206|bytes 2-5/10|2345");
  expect(await read("bytes=-3")).toBe("206|bytes 7-9/10|789");
  expect(await read("bytes=8-")).toBe("206|bytes 8-9/10|89");
  expect(await read("bytes=10-12")).toBe("416|bytes */10|");
  expect(await read("bytes=0-1", "..%2F..%2Fbb.db")).toBe("400||");
  expect(await read(undefined, "missing.txt")).toBe("404||");
  const empty = await upload(new File([], "empty.png", { type: "image/png" }));
  const image = uploadedPromptAttachmentSchema.parse(empty.uploaded);
  expect(image.type).toBe("localImage");
  expect(await read("bytes=0-99", image.path)).toBe("416|bytes */0|");
  const tooLarge = new File([new Uint8Array(35 * 1024 * 1024 + 1)], "big.bin");
  const message = "big.bin is 35MB, over the 35MB attachment limit";
  expect(await upload(tooLarge)).toMatchObject({ uploaded: { message } });
  const json = { sourceProjectId: project.id, paths: [attachment.path] };
  const copy = server.api.projects[":id"].attachments.copy;
  expect((await copy.$post({ param: personal, json })).status).toBe(200);
  const copied = await read("bytes=9-", attachment.path, personal.id);
  expect(copied).toBe("206|bytes 9-9/10|9");
});
