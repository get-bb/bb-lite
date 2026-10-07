import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { parsed, runBb } from "./helpers.js";

const EXPIRES_AT = 1_800_000_000_000;
const ADA = { id: "usr_1", name: "Ada", email: null, role: "owner" };
const ANSWERS: Record<string, unknown> = {
  "GET /api/v1/auth/session": { user: ADA },
  "GET /api/v1/users": [{ ...ADA, disabledAt: null }],
  "POST /api/v1/user-invites": {
    id: "inv_1",
    role: "member",
    expiresAt: EXPIRES_AT,
    url: "http://bb/invite/tok",
  },
  "POST /api/v1/users/usr_1/sign-in-links": {
    url: "http://bb/sign-in/tok",
    expiresAt: EXPIRES_AT,
  },
  "PATCH /api/v1/hosts/host_1/sharing": { id: "host_1", sharing: "shared" },
};

async function fakeServer() {
  const seen: { call: string; body: string; threadId: unknown }[] = [];
  const server = createServer((request, response) => {
    const call = `${request.method} ${request.url}`;
    const threadId = request.headers["x-bb-thread-id"];
    let body = "";
    request.on("data", (chunk) => (body += String(chunk)));
    request.on("end", () => {
      seen.push({ call, body, threadId });
      const answer = ANSWERS[call];
      response.writeHead(answer === undefined ? 404 : 200, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify(answer ?? { error: { message: "none" } }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const bb = (args: string[], env: Record<string, string> = {}) =>
    runBb(args, { BB_SERVER_URL: url, ...env });
  return { bb, seen, close: () => server.close() };
}

it("manages people, invites, sign-in links and machine sharing", async () => {
  const { bb, seen, close } = await fakeServer();
  const expires = new Date(EXPIRES_AT).toLocaleString();
  const who = await bb(["whoami"], { BB_THREAD_ID: "thr_abc" });
  expect(who.stdout).toBe("Ada  owner  usr_1\n");
  const listed = await bb(["users", "list"]);
  expect(listed.stdout).toContain("usr_1  Ada   -      owner  active");
  const invite = await bb([
    "user",
    "invite",
    "--name",
    "Bo",
    "--role",
    "member",
  ]);
  expect(invite.stdout).toBe(
    `Invite inv_1 for a new member (expires ${expires}):\nhttp://bb/invite/tok\n`,
  );
  const link = await bb(["user", "sign-in-link", "--json"]);
  expect(parsed<{ userId: string }>(link).userId).toBe("usr_1");
  const shared = await bb(["machine", "share", "host_1"]);
  expect(shared.stdout).toBe("Machine host_1 is shared\n");
  const role = await bb(["user", "role", "usr_1", "admin"]);
  expect(role.stderr).toContain("Invalid role 'admin'");
  close();
  expect(seen.map(({ call }) => call)).toEqual([
    "GET /api/v1/auth/session",
    "GET /api/v1/users",
    "POST /api/v1/user-invites",
    "GET /api/v1/auth/session",
    "POST /api/v1/users/usr_1/sign-in-links",
    "PATCH /api/v1/hosts/host_1/sharing",
  ]);
  expect(seen[0]?.threadId).toBe("thr_abc");
  expect(seen[1]?.threadId).toBeUndefined();
  expect(JSON.parse(seen[2]?.body ?? "")).toEqual({
    name: "Bo",
    role: "member",
  });
  expect(JSON.parse(seen[5]?.body ?? "")).toEqual({ sharing: "shared" });
}, 60_000);
