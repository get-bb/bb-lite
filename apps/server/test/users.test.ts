import { readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it, onTestFinished, vi } from "vitest";
import { WebSocket } from "ws";
import { openDatabase } from "../src/db/index.js";
import { scratch, TestSocket, type Json } from "./helpers.js";
import {
  createThreadServer,
  text,
  type ThreadServer,
} from "./thread-harness.js";

type Reply = { status: number; body: Json };

const REMOTE_HOST = "bb.example.test";
const OWNER = "usr_owner";
const PASSWORD = "correct horse";

function visitor(server: ThreadServer) {
  let cookie = "";
  const call = async (
    method: string,
    path: string,
    json?: unknown,
    extra: Record<string, string> = {},
  ): Promise<Reply> => {
    const headers: Record<string, string> = { host: REMOTE_HOST, ...extra };
    if (cookie !== "") headers.cookie = cookie;
    if (json !== undefined) headers["content-type"] = "application/json";
    const sent = json === undefined ? undefined : JSON.stringify(json);
    const target = `${server.url}/api/v1${path}`;
    const reply = await new Promise<Reply>((resolve, reject) => {
      const outgoing = request(target, { method, headers }, (response) => {
        const [issued] = response.headers["set-cookie"] ?? [];
        if (issued !== undefined) cookie = issued.split(";")[0] ?? "";
        const { statusCode: status = 0 } = response;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const received = Buffer.concat(chunks).toString();
          resolve({ status, body: JSON.parse(received) as Json });
        });
      });
      outgoing.on("error", reject);
      outgoing.end(sent);
    });
    await server.settle();
    return reply;
  };
  const socket = (): Promise<TestSocket> =>
    new Promise((resolve, reject) => {
      const headers = { host: REMOTE_HOST, cookie };
      const url = `${server.url.replace("http", "ws")}/ws`;
      const opened = new WebSocket(url, { headers });
      onTestFinished(() => opened.terminate());
      opened.on("open", () => resolve(new TestSocket(opened)));
      opened.on("error", reject);
    });
  return { call, socket };
}

async function invite(server: ThreadServer, name: string) {
  const email = `${name.toLowerCase()}@example.test`;
  const created = await server.http("POST", "/user-invites", { name, email });
  const token = new URL(String(created.body.url)).searchParams.get("token");
  const member = visitor(server);
  const account = { name, email, password: PASSWORD };
  const path = `/auth/invites/${token}`;
  const accepted = await member.call("POST", `${path}/accept`, account);
  const user = accepted.body.user as { id: string };
  return { ...member, id: user.id, email, token, path, created, accepted };
}

function spawnRequest(overrides: Json = {}) {
  return {
    projectId: "proj_1",
    origin: "app",
    input: text("Please look at the flaky scheduler test"),
    model: "gpt-test",
    environment: { type: "project-default" },
    startedOnBehalfOf: null,
    ...overrides,
  };
}

it("signs people in through invites, passwords and sign-in links", async () => {
  const server = await createThreadServer();
  const stranger = visitor(server);
  const anonymous = await stranger.call("GET", "/auth/session");
  expect(anonymous).toEqual({ status: 200, body: { user: null } });
  const refused = await stranger.call("GET", "/threads");
  expect(refused).toMatchObject({
    status: 401,
    body: { code: "unauthenticated" },
  });
  const local = await server.http("GET", "/auth/session");
  expect(local.body.user).toMatchObject({ id: OWNER, role: "owner" });

  const bo = await invite(server, "Bo");
  expect(bo.created).toMatchObject({ status: 201, body: { role: "member" } });
  expect(String(bo.created.body.url)).toContain("/join?token=bbi_");
  expect(bo.accepted.body.user).toMatchObject({
    name: "Bo",
    email: "bo@example.test",
    role: "member",
    hasPassword: true,
  });
  const reused = await stranger.call("GET", bo.path);
  expect(reused).toMatchObject({
    status: 404,
    body: { code: "invite_not_found" },
  });
  const session = await bo.call("GET", "/auth/session");
  expect(session.body.user).toMatchObject({ id: bo.id });
  const users = await bo.call("GET", "/users");
  expect(users.body).toMatchObject([{ id: OWNER }, { id: bo.id }]);

  const forbidden = { status: 403 };
  expect(await bo.call("POST", "/user-invites", {})).toMatchObject(forbidden);
  const promote = { role: "owner" };
  expect(await bo.call("PATCH", `/users/${bo.id}`, promote)).toMatchObject(
    forbidden,
  );
  const evil = { origin: "https://evil.example" };
  const forged = await bo.call("PATCH", `/users/${bo.id}`, { name: "X" }, evil);
  expect(forged).toMatchObject({
    status: 403,
    body: { code: "forbidden_origin" },
  });
  const demote = await server.http("PATCH", `/users/${OWNER}`, {
    role: "member",
  });
  expect(demote).toMatchObject({ status: 409, body: { code: "last_owner" } });

  await bo.call("POST", "/auth/logout");
  expect((await bo.call("GET", "/auth/session")).body).toEqual({ user: null });
  const wrong = { email: bo.email, password: "not the password" };
  const denied = await bo.call("POST", "/auth/login", wrong);
  expect(denied).toMatchObject({
    status: 401,
    body: { code: "invalid_credentials" },
  });
  const right = { email: "BO@example.test", password: PASSWORD };
  expect(await bo.call("POST", "/auth/login", right)).toMatchObject({
    status: 200,
  });

  const link = await server.http("POST", `/users/${bo.id}/sign-in-links`);
  expect(String(link.body.url)).toContain("/signin?token=bbi_");
  const linkToken = new URL(String(link.body.url)).searchParams.get("token");
  const phone = visitor(server);
  const exchange = `/auth/invites/${linkToken}/accept`;
  const exchanged = await phone.call("POST", exchange, {});
  expect(exchanged.body.user).toMatchObject({ id: bo.id });
  expect(await phone.call("POST", exchange, {})).toMatchObject({ status: 404 });

  await server.http("PATCH", `/users/${bo.id}`, { disabled: true });
  expect(await phone.call("GET", "/threads")).toMatchObject({ status: 401 });
  expect(await bo.call("POST", "/auth/login", right)).toMatchObject({
    status: 401,
  });
});

it("keeps a private machine to its owner and says who did what", async () => {
  const server = await createThreadServer();
  const { hostId } = server;
  const mine = await server.spawn();
  expect(server.thread(mine)).toMatchObject({ createdByUserId: OWNER });
  const bo = await invite(server, "Bo");
  const notShared = { status: 403, body: { code: "machine_not_shared" } };

  const hosts = await bo.call("GET", "/hosts");
  const local = { id: hostId, ownerUserId: OWNER, sharing: "private" };
  expect(hosts.body).toMatchObject([{ ...local, usable: false }]);
  expect(await bo.call("POST", "/threads", spawnRequest())).toMatchObject(
    notShared,
  );
  const message = { input: text("can I join in?"), mode: "auto" };
  const send = `/threads/${mine}/send`;
  expect(await bo.call("POST", send, message)).toMatchObject(notShared);
  expect(await bo.call("POST", `/threads/${mine}/stop`)).toMatchObject(
    notShared,
  );
  expect(await bo.call("GET", `/threads/${mine}/timeline`)).toMatchObject({
    status: 200,
  });
  const share = { sharing: "shared" };
  const sharing = `/hosts/${hostId}/sharing`;
  expect(await bo.call("PATCH", sharing, share)).toMatchObject({ status: 403 });
  expect(await server.http("PATCH", sharing, share)).toMatchObject({
    body: { sharing: "shared", usable: true },
  });

  const created = await bo.call("POST", "/threads", spawnRequest());
  expect(created).toMatchObject({ status: 201 });
  const theirs = String(created.body.id);
  expect(server.thread(theirs)).toMatchObject({ createdByUserId: bo.id });
  const [request] = server.eventData(theirs, "client/turn/requested");
  expect(request).toMatchObject({ initiator: "user", actorUserId: bo.id });
  await server.runTurn(mine, "t1");
  expect(await bo.call("POST", send, message)).toMatchObject({ status: 200 });
  const requests = server.eventData(mine, "client/turn/requested");
  expect(requests.map((event) => event.actorUserId)).toEqual([OWNER, bo.id]);
  const timeline = await bo.call("GET", `/threads/${mine}/timeline`);
  const senders = (timeline.body.rows as Json[])
    .filter((row) => row.role === "user")
    .map((row) => row.actorUserId);
  expect(senders).toEqual([OWNER, bo.id]);

  const asAgent = { "x-bb-thread-id": theirs };
  const child = spawnRequest({ origin: "cli", parentThreadId: theirs });
  const spawned = await fetch(`${server.url}/api/v1/threads`, {
    method: "POST",
    headers: { "content-type": "application/json", ...asAgent },
    body: JSON.stringify(child),
  });
  const { id: childId } = (await spawned.json()) as { id: string };
  await server.settle();
  expect(server.thread(childId)).toMatchObject({ createdByUserId: bo.id });

  await bo.call("POST", `/threads/${mine}/pin`);
  const pinned = async (call: Promise<Reply>) => (await call).body.pinnedAt;
  expect(await pinned(bo.call("GET", `/threads/${mine}`))).toBeTypeOf("number");
  expect(await pinned(server.http("GET", `/threads/${mine}`))).toBeNull();

  await server.http("PATCH", sharing, { sharing: "private" });
  expect(await bo.call("POST", send, message)).toMatchObject(notShared);
});

it("gives a machine to whoever adds it", async () => {
  const server = await createThreadServer();
  const bo = await invite(server, "Bo");
  const manual = { machineProviderId: "manual", inputs: null };
  const added = await bo.call("POST", "/hosts", manual);
  expect(added).toMatchObject({ status: 201, body: { ownerUserId: bo.id } });
  const path = `/hosts/${String(added.body.id)}`;
  const command = await bo.call("GET", `${path}/enrollment-command`);
  expect(String(command.body.command)).toContain("bb runner join ");
  const all = "/hosts?includeCreating=true";
  const seen = (await server.http<Json[]>("GET", all)).body;
  const usable = seen.map((host) => [host.id === added.body.id, host.usable]);
  expect(usable.sort()).toEqual([
    [false, true],
    [true, false],
  ]);
  const cai = await invite(server, "Cai");
  const rename = { name: "not yours" };
  expect(await cai.call("PATCH", path, rename)).toMatchObject({ status: 403 });
  expect(await server.http("PATCH", path, rename)).toMatchObject({
    status: 200,
  });
});

it("tells everyone who is viewing which thread", async () => {
  const server = await createThreadServer();
  const threadId = await server.spawn();
  const bo = await invite(server, "Bo");
  const owner = await server.socket();
  const latest = (client: TestSocket) => client.presence.at(-1)?.users;
  const alone = [{ userId: OWNER, threadIds: [] }];
  await vi.waitFor(() => expect(latest(owner)).toEqual(alone));
  const member = await bo.socket();
  member.send({ type: "presence", threadIds: [threadId] });
  const both = [
    { userId: bo.id, threadIds: [threadId] },
    { userId: OWNER, threadIds: [] },
  ].sort((left, right) => left.userId.localeCompare(right.userId));
  await vi.waitFor(() => expect(latest(owner)).toEqual(both));
  expect(latest(member)).toEqual(both);
  expect((await bo.call("GET", "/presence")).body).toEqual({ users: both });
  member.socket.close();
  await vi.waitFor(() => expect(latest(owner)).toEqual(alone));
  const refused = new WebSocket(`${server.url.replace("http", "ws")}/ws`, {
    headers: { host: REMOTE_HOST },
  });
  refused.on("error", () => {});
  const status = await new Promise((resolve) =>
    refused.on("unexpected-response", (_request, { statusCode }) =>
      resolve(statusCode),
    ),
  );
  expect(status).toBe(401);
});

it("hands an existing single-user database to the first owner", () => {
  const path = join(scratch(), "bb.db");
  const schema = new URL("../src/db/schema.sql", import.meta.url);
  const before = new Database(path);
  before.exec(readFileSync(schema, "utf8"));
  before.pragma("user_version = 1");
  before.exec(`
    INSERT INTO hosts (id, name, created_at, updated_at)
      VALUES ('host_1', 'box', 1, 1);
    INSERT INTO projects (id, name, created_at, updated_at)
      VALUES ('proj_1', 'P', 1, 1);
    INSERT INTO thread_sections VALUES ('sec_1', 'Later', 1, 1);
    INSERT INTO threads (id, project_id, provider_id, section_id, pinned_at,
        pin_sort_key, last_read_at, latest_attention_at, created_at, updated_at)
      VALUES ('thr_1', 'proj_1', 'echo', 'sec_1', 5, 'V', 7, 9, 1, 1);
    INSERT INTO ui_preferences VALUES ('sidebar.organizationMode', '"x"', 3, 1);
    INSERT INTO thread_tabs VALUES ('thr_1', '[]', 2, 1);
    INSERT INTO prompt_history_entries (id, project_id, thread_id, scope,
        request_sequence, input, created_at)
      VALUES ('phist_1', 'proj_1', 'thr_1', 'thread', 1, '[]', 1);
  `);
  before.close();
  const db = openDatabase({ path });
  const one = (sql: string) => db.get<Json>(sql);
  const owned = { userId: "usr_owner" };
  expect(one("SELECT * FROM users")).toMatchObject({ role: "owner" });
  expect(one("SELECT * FROM hosts")).toMatchObject({
    ownerUserId: "usr_owner",
    sharing: "private",
  });
  expect(one("SELECT * FROM threads")).toMatchObject({
    createdByUserId: "usr_owner",
    pinnedAt: null,
    sectionId: null,
  });
  expect(one("SELECT * FROM thread_user_state")).toMatchObject({
    ...owned,
    lastReadAt: 7,
    pinnedAt: 5,
    pinSortKey: "V",
    sectionId: "sec_1",
  });
  expect(one("SELECT * FROM thread_sections")).toMatchObject(owned);
  expect(one("SELECT * FROM ui_preferences")).toMatchObject({
    ...owned,
    revision: 3,
  });
  expect(one("SELECT * FROM thread_tabs")).toMatchObject({
    ...owned,
    revision: 2,
  });
  expect(one("SELECT * FROM prompt_history_entries")).toMatchObject(owned);
  expect(one("PRAGMA foreign_key_check")).toBeUndefined();
  db.close();
});
