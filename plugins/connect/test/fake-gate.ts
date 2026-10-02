import { once } from "node:events";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { buffer } from "node:stream/consumers";
import * as wire from "@bb/tunnel-contract";
import { onTestFinished } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { Link } from "../src/account.js";

type Admission = { auth?: "session" | "machine"; machineId?: string };
type Reply = [status: number, body?: unknown];

const MACHINE_HEADER = "x-bb-connect-machine";
const GATE_HEADERS = ["x-bb-gate-auth", "x-bb-gate-machine-id", MACHINE_HEADER];
const HOP_HEADERS =
  /^(connection|keep-alive|transfer-encoding|upgrade|expect|host|sec-websocket-(key|version|extensions)|x-bb-tunnel-target)$/iu;
const ACCOUNT_PATH = /^\/api\/(account|connect)\//u;
const PUBLIC_PATHS = ["/install.sh", "/install/version", "/install/bb-app.tgz"];
const MACHINE_PATH = /^\/(internal|api\/v1(\/|$))/u;

export async function startFakeGate() {
  const sockets = new WebSocketServer({ noServer: true });
  const pending = new Map<number, ServerResponse>();
  const visitors = new Map<number, WebSocket>();
  let tunnel: WebSocket | null = null;
  let streamId = 0;
  let minted = 0;
  const gate = {
    apexUrl: "",
    gateUrl: "",
    credential: "bbcred_first",
    calls: [] as string[],
    pollReplies: [] as Reply[],
    dialStatus: 0,
    profileStatus: 200,
    ackHeartbeats: true,
    tunnelsAccepted: 0,
    machines: new Map<string, string>(),
    revoked: [] as string[],
    link: (): Link => ({
      baseUrl: gate.apexUrl,
      serverUrl: gate.gateUrl,
      serverId: "srv_1",
      serverLabel: "bee",
      credential: gate.credential,
    }),
  };
  const send = (frame: wire.Frame) => tunnel?.send(wire.encodeFrame(frame));
  const owned = ({ headers }: IncomingMessage) =>
    headers[MACHINE_HEADER] === gate.credential &&
    headers.authorization === `Bearer ${gate.credential}`;

  async function account(request: IncomingMessage): Promise<Reply | null> {
    const { gateUrl: serverUrl, apexUrl } = gate;
    const path = request.url ?? "";
    if (!ACCOUNT_PATH.test(path)) return null;
    const input = (await buffer(request)).toString();
    const body = JSON.parse(input || "{}") as Record<string, string>;
    switch (path) {
      case "/api/account/link/start": {
        const verificationUrl = `${apexUrl}/link?code=ABCD-1234`;
        const codes = { deviceCode: "bbdev_1", userCode: "ABCD-1234" };
        const expiresAt = Date.now() + 600_000;
        return [200, { ...codes, verificationUrl, expiresAt, intervalMs: 1 }];
      }
      case "/api/account/link/poll":
        return gate.pollReplies.shift() ?? [200, { status: "pending" }];
      case "/api/account/me": {
        const profile = { serverId: "srv_1", serverLabel: "bee", serverUrl };
        if (!owned(request) || gate.profileStatus === 401) return [401];
        return [gate.profileStatus, profile];
      }
      case "/api/connect/disconnect":
        if (request.headers[MACHINE_HEADER] !== gate.credential) return [401];
        gate.credential = "bbcred_revoked";
        tunnel?.close(1000, "revoked by owner");
        return [200, { ok: true }];
      case "/api/connect/machine-code":
        if (!owned(request)) return [401, { error: "signed-out" }];
        return [200, { code: "mc_1", expiresInMs: 600_000, serverUrl }];
      case "/api/connect/redeem-machine": {
        if (body.code !== "mc_1") return [404];
        minted += 1;
        const [credential, machineId] = [`bbcm_${minted}`, `machine_${minted}`];
        gate.machines.set(credential, machineId);
        return [200, { credential, machineId, serverUrl }];
      }
      case "/api/connect/revoke-machine":
        if (!owned(request)) return [401];
        gate.revoked.push(String(body.machineId));
        return [200, { ok: true }];
      default:
        return [404];
    }
  }

  function admit(request: IncomingMessage): Admission | number {
    const { method = "", headers, url = "/" } = request;
    const [path = "/"] = url.split("?");
    const shared = /^[a-z0-9-]+--\d+\./u.test(headers.host ?? "");
    const presented = headers[MACHINE_HEADER];
    if (method === "GET" && PUBLIC_PATHS.includes(path)) return {};
    if (MACHINE_PATH.test(path) && typeof presented === "string") {
      const machineId = gate.machines.get(presented);
      if (shared || machineId === undefined) return 403;
      return { auth: "machine", machineId };
    }
    if (path.startsWith("/internal")) return 403;
    return headers.cookie === "session=owner" ? { auth: "session" } : 401;
  }

  function opening(request: IncomingMessage, admission: Admission) {
    const { rawHeaders, url: path = "/" } = request;
    const headers: wire.HeaderPair[] = [];
    for (let index = 0; index < rawHeaders.length; index += 2) {
      const name = String(rawHeaders[index]).toLowerCase();
      if (HOP_HEADERS.test(name) || GATE_HEADERS.includes(name)) continue;
      headers.push([name, String(rawHeaders[index + 1])]);
    }
    const { auth, machineId } = admission;
    if (auth !== undefined) headers.push(["x-bb-gate-auth", auth]);
    if (machineId) headers.push(["x-bb-gate-machine-id", machineId]);
    const target = /--(\d+)\./u.exec(request.headers.host ?? "")?.[1];
    streamId += 1;
    return { streamId, path, headers, ...(target ? { target } : {}) };
  }

  async function onRequest(request: IncomingMessage, response: ServerResponse) {
    const side = request.headers.host?.startsWith("localhost")
      ? "apex"
      : "gate";
    gate.calls.push(`${side} ${request.method} ${request.url}`);
    const answer = (await account(request)) ?? admit(request);
    if (typeof answer === "number" || Array.isArray(answer)) {
      const [status, body] = Array.isArray(answer) ? answer : [answer];
      response.writeHead(status, { "content-type": "application/json" });
      return void response.end(JSON.stringify(body ?? {}));
    }
    if (tunnel === null) return void response.writeHead(503).end();
    const { method = "GET" } = request;
    const hasBody = method !== "GET" && method !== "HEAD";
    const open = opening(request, answer);
    pending.set(open.streamId, response);
    send({ type: "open-http", method, hasBody, ...open });
    if (!hasBody) return;
    for await (const data of request) {
      send({ type: "body-chunk", streamId: open.streamId, data });
    }
    send({ type: "body-end", streamId: open.streamId });
  }

  function onFrame(frame: wire.Frame): void {
    const { streamId: id } = frame;
    const response = pending.get(id);
    const visitor = visitors.get(id);
    if (frame.type === "resp-head") {
      const kept = frame.headers.filter(([name]) => !HOP_HEADERS.test(name));
      response?.writeHead(frame.status, kept.flat());
    } else if (frame.type === "body-chunk") {
      response?.write(frame.data);
    } else if (frame.type === "body-end") {
      response?.end();
      pending.delete(id);
    } else if (frame.type === "ws-data") {
      const { data, isBinary } = frame;
      visitor?.send(isBinary ? data : Buffer.from(data).toString());
    } else if (frame.type === "close-stream") {
      if (response?.headersSent === false) response.writeHead(502);
      response?.end();
      visitor?.close(frame.code, frame.reason);
    }
  }

  function acceptTunnel(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) {
    const bearer = `Bearer ${gate.credential}`;
    const refusal =
      gate.dialStatus || (request.headers.authorization === bearer ? 0 : 401);
    if (refusal !== 0 || !request.url?.endsWith("?v=1")) {
      return void socket.end(`HTTP/1.1 ${refusal || 400} Refused\r\n\r\n`);
    }
    sockets.handleUpgrade(request, socket, head, (accepted) => {
      tunnel?.close(1000, wire.TUNNEL_REPLACED_CLOSE_REASON);
      for (const visitor of visitors.values())
        visitor.close(1001, "reconnected");
      tunnel = accepted;
      gate.tunnelsAccepted += 1;
      accepted.on("message", (data: Buffer, isBinary) => {
        if (isBinary) return onFrame(wire.decodeFrame(data));
        const beat =
          data.toString() === wire.HEARTBEAT_REQUEST && gate.ackHeartbeats;
        if (beat) accepted.send(wire.HEARTBEAT_RESPONSE);
      });
      accepted.on("close", () => {
        if (tunnel === accepted) tunnel = null;
      });
    });
  }

  function onUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    if (request.url?.startsWith("/__tunnel")) {
      return acceptTunnel(request, socket, head);
    }
    const admission = admit(request);
    if (typeof admission === "number" || tunnel === null) {
      return void socket.end(`HTTP/1.1 ${admission} Refused\r\n\r\n`);
    }
    const offered = request.headers["sec-websocket-protocol"] ?? "";
    const protocols = offered.split(",").flatMap((name) => name.trim() || []);
    const open = opening(request, admission);
    const { streamId: id } = open;
    send({ type: "open-ws", protocols, ...open });
    sockets.handleUpgrade(request, socket, head, (visitor) => {
      visitors.set(id, visitor);
      visitor.on("message", (data: Buffer, isBinary) => {
        send({ type: "ws-data", streamId: id, isBinary, data });
      });
      visitor.on("close", (code, reason) => {
        const sent = code === 1000 || code >= 3000 ? code : 1000;
        const closing = { code: sent, reason: reason.toString() };
        send({ type: "close-stream", streamId: id, ...closing });
      });
    });
  }

  const server = http.createServer(onRequest).on("upgrade", onUpgrade);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  gate.apexUrl = `http://localhost:${port}`;
  gate.gateUrl = `http://127.0.0.1:${port}`;
  onTestFinished(() => {
    for (const client of [tunnel, ...visitors.values()]) client?.terminate();
    server.closeAllConnections();
    server.close();
  });
  return gate;
}

export type FakeGate = Awaited<ReturnType<typeof startFakeGate>>;

type Visit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export async function visit(gate: FakeGate, path: string, init: Visit = {}) {
  const { method = "GET", headers = {}, body } = init;
  const request = http.request(`${gate.gateUrl}${path}`, { method, headers });
  request.end(body);
  const [response] = (await once(request, "response")) as [IncomingMessage];
  const chunked = response.headers["transfer-encoding"] === "chunked";
  const text = (await buffer(response)).toString();
  return { status: response.statusCode ?? 0, text, chunked };
}
