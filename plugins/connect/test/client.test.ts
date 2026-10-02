import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, it, onTestFinished, vi } from "vitest";
import { WebSocket } from "ws";
import { ConnectAccount } from "../src/account.js";
import { ConnectTunnel, type TunnelOptions } from "../src/tunnel.js";
import { startFakeGate, visit } from "./fake-gate.js";

const OWNER = { cookie: "session=owner" };
const FAST = { retryBaseMs: 4, retryMaxMs: 8, replacedHoldMs: 400 };

async function startEchoOrigin(): Promise<string> {
  const origin = http.createServer(async (request, response) => {
    const { method, url, headers } = request;
    const body = (await buffer(request)).toString();
    response.end(JSON.stringify({ method, url, headers, body }));
  });
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  onTestFinished(() => void origin.close());
  return `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
}

async function startClient(heartbeat?: TunnelOptions["heartbeat"]) {
  const gate = await startFakeGate();
  const loopbackUrl = await startEchoOrigin();
  const file = join(mkdtempSync(join(tmpdir(), "bb-connect-")), "connect.json");
  const account = new ConnectAccount({
    file,
    baseUrl: gate.apexUrl,
    clientName: "test",
    warn: () => {},
    onChange: () => tunnel.set(account.link),
    pollMarginMs: 5,
    slowDownStepMs: 5,
  });
  const tunnel = new ConnectTunnel({
    loopbackUrl,
    isShared: () => false,
    confirmRefused: (credential) => account.confirmRefused(credential),
    log: { info: () => {}, warn: () => {} },
    onChange: () => {},
    ...FAST,
    heartbeat,
  });
  onTestFinished(() => tunnel.set(null));
  const state = () => tunnel.status().state;
  const error = () => tunnel.status().lastError;
  const connected = () => vi.waitFor(() => expect(state()).toBe("connected"));
  const polls = () =>
    gate.calls.filter((call) => call.endsWith("/poll")).length;
  const tools = { state, error, connected, polls };
  return { gate, account, tunnel, file, loopbackUrl, ...tools };
}

it("marks forwarded requests and drops a visitor's own marker", async () => {
  const { gate, account, connected, loopbackUrl } = await startClient();
  account.adopt(gate.link());
  await connected();
  const forged = { "X-BB-Via-Tunnel": "0", "x-bb-gate-auth": "machine" };
  const headers = { ...OWNER, ...forged, origin: gate.gateUrl };
  const sent = { method: "POST", headers, body: "hello" };
  const { status, text } = await visit(gate, "/echo?x=1", sent);
  const seen = JSON.parse(text) as { headers: Record<string, string> };
  expect(status).toBe(200);
  expect(seen).toMatchObject({ ...sent, url: "/echo?x=1", headers: {} });
  expect(seen.headers).toMatchObject({
    "x-bb-via-tunnel": "1",
    "x-bb-gate-auth": "session",
    origin: loopbackUrl,
    host: new URL(loopbackUrl).host,
    ...OWNER,
  });
  expect((await visit(gate, "/echo")).status).toBe(401);
});

it("redials after a lost keepalive and holds off when replaced", async () => {
  const heartbeat = { intervalMs: 10, deadlineMs: 40 };
  const { gate, account, tunnel, connected, error } =
    await startClient(heartbeat);
  account.adopt(gate.link());
  await connected();
  gate.ackHeartbeats = false;
  await vi.waitFor(() => expect(gate.tunnelsAccepted).toBeGreaterThan(1));
  gate.ackHeartbeats = true;
  await sleep(100);
  await connected();
  const headers = { authorization: `Bearer ${gate.credential}` };
  const dialUrl = `${gate.gateUrl.replace("http", "ws")}/__tunnel?v=1`;
  const intruder = new WebSocket(dialUrl, { headers });
  onTestFinished(() => intruder.terminate());
  await vi.waitFor(() => expect(error()).toMatch(/took over/u));
  const { state, nextRetryAt } = tunnel.status();
  expect(state).toBe("reconnecting");
  expect(nextRetryAt).toBeGreaterThan(Date.now() + 200);
  const held = gate.tunnelsAccepted;
  await sleep(100);
  expect(gate.tunnelsAccepted).toBe(held);
  await vi.waitFor(() => expect(gate.tunnelsAccepted).toBe(held + 1));
});

it("clears a refused credential only when the account agrees", async () => {
  const { gate, account, file, state, error } = await startClient();
  const checked = () => gate.calls.includes("apex GET /api/account/me");
  gate.dialStatus = 401;
  account.adopt(gate.link());
  await vi.waitFor(() => expect(error()).toMatch(/401/u));
  await vi.waitFor(() => expect(checked()).toBe(true));
  await sleep(40);
  expect(account.link).toEqual(gate.link());
  expect(state()).toBe("reconnecting");
  gate.profileStatus = 401;
  await vi.waitFor(() => expect(account.link).toBeNull());
  expect([existsSync(file), state()]).toEqual([false, "disconnected"]);
});

it("links at the first approval and stops polling", async () => {
  const { gate, account, file, connected, polls } = await startClient();
  const { credential, serverId } = gate.link();
  const approved = { status: "approved", credential, serverId };
  gate.pollReplies.push([200, { status: "pending" }], [429], [200, approved]);
  const login = await account.startLogin();
  expect(login).toMatchObject({ state: "pending", userCode: "ABCD-1234" });
  expect(login.verificationUrl).toContain(gate.apexUrl);
  expect(await account.startLogin()).toBe(login);
  await connected();
  expect(account.login?.state).toBe("signed-in");
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(gate.link());
  expect(statSync(file).mode & 0o777).toBe(0o600);
  await sleep(60);
  expect(polls()).toBe(3);
});

it("reports a denied or expired sign-in and signs out", async () => {
  const { gate, account, file, connected, state } = await startClient();
  for (const refusal of [{ 403: "denied" }, { 410: "expired" }]) {
    const [[status, reason]] = Object.entries(refusal);
    gate.pollReplies.push([Number(status)]);
    await account.startLogin();
    await vi.waitFor(() => expect(account.login?.state).toBe("failed"));
    expect(account.login?.message).toContain(reason);
  }
  expect(account.link).toBeNull();
  account.adopt(gate.link());
  await connected();
  expect(await account.logout()).toEqual({ revoked: true });
  expect(gate.calls).toContain("gate POST /api/connect/disconnect");
  expect([existsSync(file), state()]).toEqual([false, "disconnected"]);
  await sleep(40);
  expect(gate.tunnelsAccepted).toBe(1);
});
