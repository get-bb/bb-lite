import { once } from "node:events";
import { mkdtempSync } from "node:fs";
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
  });
  const tunnel = new ConnectTunnel({
    loopbackUrl,
    marker: "1",
    originOf: () => null,
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
  return { gate, account, tunnel, loopbackUrl, state, error, connected };
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
