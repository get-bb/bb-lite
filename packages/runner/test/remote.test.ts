import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  FILE_PAYLOAD_MAX_BYTES,
  LIVE_OUTPUT_KEEP_NEWEST,
  connectRemoteRunner,
  createEchoAdapter,
  createLocalRunner,
  serveRunner,
  startCliProxy,
  type RunnerEvent,
  type RunnerEventSink,
  type RunnerServing,
} from "@bb/runner";
import { until } from "./kit.js";

const MIB = 1024 * 1024;

async function socketPair() {
  const acceptor = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(acceptor, "listening");
  const { port } = acceptor.address() as AddressInfo;
  const dialed = new WebSocket(`ws://127.0.0.1:${port}`);
  const wireSizes: number[] = [];
  const [[accepted]] = await Promise.all([
    once(acceptor, "connection") as Promise<[WebSocket]>,
    once(dialed, "open"),
  ]);
  for (const socket of [dialed, accepted]) {
    socket.on("message", (data: Buffer) => wireSizes.push(data.byteLength));
  }
  onTestFinished(() => {
    dialed.terminate();
    acceptor.close();
  });
  return { runnerSide: dialed, serverSide: accepted, wireSizes };
}

function startLocalRunner() {
  const dataDir = mkdtempSync(join(tmpdir(), "bb-remote-runner-"));
  let serving: RunnerServing | null = null;
  const runner = createLocalRunner({
    dataDir,
    serverUrl: "http://127.0.0.1:48901",
    bbCliPath: "/opt/bb/bin/bb",
    adapters: [createEchoAdapter()],
    sink: (event) => serving?.deliver(event),
  });
  onTestFinished(async () => {
    await runner.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const serve = (socket: WebSocket) => (serving = serveRunner(runner, socket));
  return { dataDir, runner, serve };
}

function rawPeer(socket: WebSocket) {
  const frames: Record<string, unknown>[] = [];
  socket.on("message", (data) => frames.push(JSON.parse(String(data))));
  const send = (frame: object) => socket.send(JSON.stringify(frame));
  const reply = (id: number) =>
    until(() => frames.find((frame) => frame.t === "res" && frame.id === id));
  return { frames, send, reply };
}

it("serves only the Runner interface and maps errors", async () => {
  const { runnerSide, serverSide } = await socketPair();
  const peer = rawPeer(serverSide);
  const { dataDir, runner, serve } = startLocalRunner();
  serve(runnerSide);
  const { instanceId } = await runner.describe();
  await until(() => peer.frames.length > 0);
  expect(peer.frames[0]).toMatchObject({ t: "hello", instanceId });
  const methods = ["shutdown", "outbox", "constructor", "nope", "describe"];
  methods.forEach((method, id) => peer.send({ t: "req", id, method }));
  const params = { path: "absent.txt", rootPath: dataDir };
  peer.send({ t: "req", id: 9, method: "readFile", params });
  peer.send({ t: "ping" });
  for (const id of [0, 1, 2, 3]) {
    const error = { code: "failed", retryable: false };
    expect(await peer.reply(id)).toMatchObject({ ok: false, error });
  }
  expect(await peer.reply(4)).toMatchObject({
    ok: true,
    result: { instanceId },
  });
  const missing = { code: "path_not_found" };
  expect(await peer.reply(9)).toMatchObject({ ok: false, error: missing });
  expect(peer.frames).toContainEqual({ t: "pong" });
});

it("rejects pending and later requests when the socket drops", async () => {
  const { runnerSide, serverSide } = await socketPair();
  const peer = rawPeer(runnerSide);
  const remote = connectRemoteRunner(serverSide, () => {});
  const pending = remote.runner.gitStatus({ path: "/repo" });
  await until(() => peer.frames.some((frame) => frame.method === "gitStatus"));
  runnerSide.terminate();
  const lost = { name: "RunnerError", code: "unavailable", retryable: true };
  await expect(pending).rejects.toMatchObject(lost);
  await remote.closed;
  await expect(remote.runner.describe()).rejects.toMatchObject(lost);
});

async function welcomedPair(sink: RunnerEventSink) {
  const { runnerSide, serverSide, wireSizes } = await socketPair();
  const { dataDir, runner, serve } = startLocalRunner();
  const remote = connectRemoteRunner(serverSide, sink);
  const serving = serve(runnerSide);
  await remote.hello;
  remote.welcome(0);
  await remote.runner.describe();
  return { dataDir, runner, remote, serving, serverSide, wireSizes };
}

it("keeps every wire frame under 1 MiB for large payloads", async () => {
  const events: RunnerEvent[] = [];
  const sink = (event: RunnerEvent) => void events.push(event);
  const { dataDir, runner, remote, wireSizes } = await welcomedPair(sink);
  const bytes = randomBytes(FILE_PAYLOAD_MAX_BYTES + 4096);
  writeFileSync(join(dataDir, "big.bin"), bytes);
  const whole = { offset: 0, length: FILE_PAYLOAD_MAX_BYTES, revision: null };
  const location = { path: "big.bin", rootPath: dataDir };
  const chunk = await remote.runner.readFileChunk({ ...location, ...whole });
  const received = Buffer.from(chunk.dataBase64, "base64");
  expect(received.equals(bytes.subarray(0, FILE_PAYLOAD_MAX_BYTES))).toBe(true);
  expect(Math.max(...wireSizes)).toBeGreaterThan(FILE_PAYLOAD_MAX_BYTES);

  const text = "\u20ac".repeat(600_000);
  const output = { kind: "script.output" as const, operationId: "op_1", text };
  await remote.runner.renameSession({ threadId: "thr_none", title: text });
  runner.outbox.emit(output);
  await until(() => events.length > 0);
  expect(events).toEqual([{ lane: "reliable", seq: 1, ...output }]);
  expect(wireSizes.filter((size) => size > MIB / 2)).toHaveLength(5);
  expect(Math.max(...wireSizes)).toBeLessThan(MIB);
});

it("sheds old terminal output under backpressure, never the tail", async () => {
  const seqs: number[] = [];
  let exited = false;
  const { serving, serverSide } = await welcomedPair((event) => {
    if (event.kind === "terminal.output") seqs.push(event.seq);
    else exited = event.kind === "terminal.exited";
  });
  serverSide.pause();
  const terminal = { lane: "live" as const, terminalId: "term_1" };
  const dataBase64 = "A".repeat(64 * 1024);
  const total = 400;
  for (let seq = 1; seq <= total; seq += 1) {
    serving.deliver({ ...terminal, kind: "terminal.output", seq, dataBase64 });
  }
  serving.deliver({ ...terminal, kind: "terminal.exited", exitCode: 0 });
  serverSide.resume();
  await until(() => exited);
  const tail = seqs.slice(-LIVE_OUTPUT_KEEP_NEWEST);
  expect(tail.at(-1)).toBe(total);
  expect(tail[0]).toBe(total - LIVE_OUTPUT_KEEP_NEWEST + 1);
  expect(seqs.length).toBeLessThan(total);
  expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
});

it("proxies the agent's bb CLI with the machine's credentials", async () => {
  const seen: { url?: string; headers: http.IncomingHttpHeaders }[] = [];
  const upstream = http.createServer((request, response) => {
    seen.push({ url: request.url, headers: request.headers });
    response.writeHead(201, { "content-type": "text/plain" });
    request.pipe(response);
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const { port } = upstream.address() as AddressInfo;
  const proxy = await startCliProxy({
    serverUrl: `http://127.0.0.1:${port}`,
    headers: { "x-bb-connect-machine": "bbcm_stored" },
    runnerToken: "bbr_stored",
  });
  onTestFinished(async () => {
    await proxy.close();
    upstream.close();
  });
  const call = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${proxy.url}${path}`, { method: "POST", headers, body: "ping" });
  const own = { authorization: "Bearer agent-supplied" };
  const sent = await call("/api/v1/threads/thr_1/send?wait=1", own);
  expect([sent.status, await sent.text()]).toEqual([201, "ping"]);
  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe("/api/v1/threads/thr_1/send?wait=1");
  expect(seen[0]?.headers).toMatchObject({
    "x-bb-connect-machine": "bbcm_stored",
    authorization: "Bearer bbr_stored",
    host: `127.0.0.1:${port}`,
  });
  const refused = await Promise.all([
    call("/api/v1/threads", { origin: "https://evil.example" }),
    call("/api/v1/threads", { "sec-fetch-site": "cross-site" }),
    call("/internal/runner/join"),
  ]);
  expect(refused.map((r) => r.status)).toEqual([403, 403, 404]);
  expect(seen).toHaveLength(1);
});
