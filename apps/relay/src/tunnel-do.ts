import { DurableObject } from "cloudflare:workers";
import * as wire from "@bb/tunnel-contract";
import {
  CLOSE_HEADER,
  OFFLINE_HEADER,
  TARGET_HEADER,
  TUNNEL_HEADER,
  isReservedCookie,
  type Env,
} from "./site.js";

interface HttpStream {
  respond(response: Response): void;
  body: ReadableStreamDefaultController<Uint8Array> | null;
  timer: ReturnType<typeof setTimeout>;
}

const TUNNEL_TAG = "tunnel";
const VISITOR_TAG = "visitor";
const HEAD_TIMEOUT_MS = 120_000;
const OPENED_AT = "tunnelOpenedAt";
const CLOSED_AT = "tunnelClosedAt";
const LOST_AT = "tunnelLostAt";
const VANISHED_GRACE_MS = 5_000;
const RETURN_GRACE_MS = 15_000;
const CLEAN_CLOSE_CODE = 1000;
const COOKIE_DOMAIN = /;\s*domain\s*(?:=|;|$)/iu;
const COMBINED_COOKIES = /,\s*[^\s;=,]+=/u;
const BODYLESS_STATUSES = [101, 204, 205, 304];
const HOP_HEADERS =
  /^(connection|keep-alive|transfer-encoding|upgrade|expect|host|content-length|sec-websocket-(key|version|extensions|accept)|x-relay-.*)$/iu;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function streamTag(streamId: number) {
  return `s:${streamId}`;
}

function relayedCloseCode(code: number) {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
}

function plain(status: number, message: string, offline = false) {
  const headers = new Headers({ "content-type": "text/plain; charset=utf-8" });
  if (offline) headers.set(OFFLINE_HEADER, "1");
  return new Response(`${message}\n`, { status, headers });
}

function forwardedHeaders(request: Request): wire.HeaderPair[] {
  const pairs: wire.HeaderPair[] = [];
  for (const [name, value] of request.headers) {
    if (!HOP_HEADERS.test(name)) pairs.push([name, value]);
  }
  return pairs;
}

function isRelayCookie(cookie: string): boolean {
  const [name = ""] = cookie.split("=");
  if (isReservedCookie(name)) return true;
  return COOKIE_DOMAIN.test(cookie) || COMBINED_COOKIES.test(cookie);
}

export class TunnelDO extends DurableObject<Env> {
  private readonly streams = new Map<number, HttpStream>();
  private readonly waiters = new Set<() => void>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const { HEARTBEAT_REQUEST: beat, HEARTBEAT_RESPONSE: ack } = wire;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(beat, ack));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get(CLOSE_HEADER) === "1") return this.revoke();
    if (request.headers.get(TUNNEL_HEADER) === "1") return this.acceptTunnel();
    const tunnel = this.tunnelSocket() ?? (await this.returningTunnel());
    if (tunnel === null) {
      return plain(503, "This bb server is not connected right now.", true);
    }
    const upgrade = request.headers.get("upgrade")?.toLowerCase();
    if (upgrade === "websocket") return this.openSocket(request, tunnel);
    return this.proxy(request, tunnel);
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (this.ctx.getTags(socket).includes(TUNNEL_TAG)) {
      if (typeof message !== "string") this.fromTunnel(message);
      else if (message === wire.HEARTBEAT_REQUEST) {
        socket.send(wire.HEARTBEAT_RESPONSE);
      }
      return;
    }
    const streamId = this.streamOf(socket);
    const isBinary = typeof message !== "string";
    const data = isBinary ? new Uint8Array(message) : encoder.encode(message);
    this.toTunnel({ type: "ws-data", streamId, isBinary, data });
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    const tunnel = this.ctx.getTags(socket).includes(TUNNEL_TAG);
    try {
      socket.close(relayedCloseCode(code), reason);
    } catch {}
    if (tunnel) return this.tunnelClosed(socket, code);
    const closing = { code: relayedCloseCode(code), reason };
    const streamId = this.streamOf(socket);
    this.toTunnel({ type: "close-stream", streamId, ...closing });
  }

  webSocketError(socket: WebSocket): void {
    this.webSocketClose(socket, 1011, "socket error");
  }

  private openTunnels(): WebSocket[] {
    const tunnels = this.ctx.getWebSockets(TUNNEL_TAG);
    return tunnels.filter((tunnel) => tunnel.readyState === WebSocket.OPEN);
  }

  private tunnelSocket(): WebSocket | null {
    return this.openTunnels()[0] ?? null;
  }

  private tunnelClosed(socket: WebSocket, code: number): void {
    const others = this.openTunnels().filter((other) => other !== socket);
    if (others.length > 0) return;
    const now = Date.now();
    const { storage } = this.ctx;
    void storage.put(CLOSED_AT, now);
    if (code === CLEAN_CLOSE_CODE) void storage.delete(LOST_AT);
    else void storage.put(LOST_AT, now);
    this.dropStreams("tunnel closed");
  }

  private async restartIfVanished(): Promise<void> {
    if (this.tunnelSocket() !== null) return;
    const { storage } = this.ctx;
    const openedAt = await storage.get<number>(OPENED_AT);
    const closedAt = await storage.get<number>(CLOSED_AT);
    if (openedAt === undefined) return;
    const unclosed = closedAt === undefined || closedAt < openedAt;
    if (!unclosed || Date.now() - openedAt <= VANISHED_GRACE_MS) return;
    const now = Date.now();
    await storage.put({ [CLOSED_AT]: now, [LOST_AT]: now });
    await storage.sync();
    this.ctx.abort("the tunnel socket disappeared without a close");
  }

  private async returningTunnel(): Promise<WebSocket | null> {
    await this.restartIfVanished();
    const lostAt = await this.ctx.storage.get<number>(LOST_AT);
    const remainingMs =
      lostAt === undefined ? 0 : lostAt + RETURN_GRACE_MS - Date.now();
    if (remainingMs <= 0) return this.tunnelSocket();
    await new Promise<void>((resolve) => {
      const settle = () => {
        clearTimeout(timer);
        this.waiters.delete(settle);
        resolve();
      };
      const timer = setTimeout(settle, remainingMs);
      this.waiters.add(settle);
    });
    return this.tunnelSocket();
  }

  private async revoke(): Promise<Response> {
    for (const tunnel of this.ctx.getWebSockets(TUNNEL_TAG)) {
      try {
        tunnel.close(CLEAN_CLOSE_CODE, "link revoked");
      } catch {}
    }
    await this.ctx.storage.put(CLOSED_AT, Date.now());
    await this.ctx.storage.delete(LOST_AT);
    this.dropStreams("link revoked");
    for (const settle of [...this.waiters]) settle();
    return new Response(null, { status: 204 });
  }

  private async acceptTunnel(): Promise<Response> {
    await this.restartIfVanished();
    for (const previous of this.openTunnels()) {
      previous.close(CLEAN_CLOSE_CODE, wire.TUNNEL_REPLACED_CLOSE_REASON);
    }
    this.dropStreams("reconnected");
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [TUNNEL_TAG]);
    await this.ctx.storage.put(OPENED_AT, Date.now());
    await this.ctx.storage.delete(LOST_AT);
    setTimeout(() => {
      for (const settle of [...this.waiters]) settle();
    }, 0);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private dropStreams(reason: string): void {
    for (const visitor of this.ctx.getWebSockets(VISITOR_TAG)) {
      try {
        visitor.close(1001, reason);
      } catch {}
    }
    for (const streamId of [...this.streams.keys()]) {
      this.failStream(streamId, 502, reason);
    }
  }

  private streamOf(socket: WebSocket): number {
    const attachment = socket.deserializeAttachment() as { streamId: number };
    return attachment.streamId;
  }

  private nextStreamId(): number {
    for (;;) {
      const [candidate = 1] = crypto.getRandomValues(new Uint32Array(1));
      const open = this.ctx.getWebSockets(streamTag(candidate)).length > 0;
      if (!open && !this.streams.has(candidate)) return candidate;
    }
  }

  private toTunnel(frame: wire.Frame, tunnel?: WebSocket): void {
    const socket = tunnel ?? this.tunnelSocket();
    try {
      socket?.send(wire.encodeFrame(frame));
    } catch {}
  }

  private openSocket(request: Request, tunnel: WebSocket): Response {
    const url = new URL(request.url);
    const streamId = this.nextStreamId();
    const offered = request.headers.get("sec-websocket-protocol") ?? "";
    const protocols = offered.split(",").flatMap((name) => name.trim() || []);
    const target = request.headers.get(TARGET_HEADER) ?? undefined;
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [VISITOR_TAG, streamTag(streamId)]);
    pair[1].serializeAttachment({ streamId });
    const path = `${url.pathname}${url.search}`;
    const headers = forwardedHeaders(request);
    const opening = { streamId, path, headers, protocols };
    const frame: wire.Frame = { type: "open-ws", ...opening };
    this.toTunnel(target === undefined ? frame : { ...frame, target }, tunnel);
    const [protocol] = protocols;
    const accepted = new Headers();
    if (protocol !== undefined)
      accepted.set("sec-websocket-protocol", protocol);
    const init = { status: 101, webSocket: pair[0], headers: accepted };
    return new Response(null, init);
  }

  private async proxy(request: Request, tunnel: WebSocket): Promise<Response> {
    const url = new URL(request.url);
    const streamId = this.nextStreamId();
    const { method } = request;
    const hasBody = request.body !== null && !["GET", "HEAD"].includes(method);
    const target = request.headers.get(TARGET_HEADER) ?? undefined;
    const answered = new Promise<Response>((respond) => {
      const timer = setTimeout(() => {
        this.failStream(streamId, 504, "The bb server did not answer in time.");
        this.toTunnel({
          type: "close-stream",
          streamId,
          code: 1000,
          reason: "",
        });
      }, HEAD_TIMEOUT_MS);
      this.streams.set(streamId, { respond, body: null, timer });
    });
    const path = `${url.pathname}${url.search}`;
    const headers = forwardedHeaders(request);
    const opening = { streamId, method, path, headers, hasBody };
    const frame: wire.Frame = { type: "open-http", ...opening };
    this.toTunnel(target === undefined ? frame : { ...frame, target }, tunnel);
    if (hasBody && request.body !== null) {
      for await (const chunk of request.body) {
        for (const part of wire.chunkBody(streamId, chunk)) {
          this.toTunnel(part, tunnel);
        }
      }
      this.toTunnel({ type: "body-end", streamId }, tunnel);
    }
    return answered;
  }

  private failStream(streamId: number, status: number, reason: string): void {
    const stream = this.streams.get(streamId);
    if (stream === undefined) return;
    this.streams.delete(streamId);
    clearTimeout(stream.timer);
    if (stream.body === null) stream.respond(plain(status, reason));
    else {
      try {
        stream.body.error(new Error(reason));
      } catch {}
    }
  }

  private answer(frame: Extract<wire.Frame, { type: "resp-head" }>): void {
    const { streamId, status } = frame;
    const stream = this.streams.get(streamId);
    if (stream === undefined || stream.body !== null) return;
    clearTimeout(stream.timer);
    const headers = new Headers();
    for (const [name, value] of frame.headers) {
      const cookie = name.toLowerCase() === "set-cookie";
      if (HOP_HEADERS.test(name) || (cookie && isRelayCookie(value))) continue;
      headers.append(name, value);
    }
    if (BODYLESS_STATUSES.includes(status)) {
      this.streams.delete(streamId);
      return stream.respond(new Response(null, { status, headers }));
    }
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        stream.body = controller;
      },
      cancel: () => {
        this.streams.delete(streamId);
        const closing = { code: 1000, reason: "visitor left" };
        this.toTunnel({ type: "close-stream", streamId, ...closing });
      },
    });
    const init = { status, headers, encodeBody: "manual" as const };
    stream.respond(new Response(body, init));
  }

  private fromTunnel(message: ArrayBuffer): void {
    let frame: wire.Frame;
    try {
      frame = wire.decodeFrame(message);
    } catch {
      return;
    }
    const { streamId } = frame;
    const stream = this.streams.get(streamId);
    if (frame.type === "resp-head") return this.answer(frame);
    if (frame.type === "body-chunk") {
      return stream?.body?.enqueue(frame.data.slice());
    }
    if (frame.type === "body-end") {
      this.streams.delete(streamId);
      return stream?.body?.close();
    }
    const [visitor] = this.ctx.getWebSockets(streamTag(streamId));
    if (frame.type === "ws-data") {
      const { data, isBinary } = frame;
      return visitor?.send(isBinary ? data.slice() : decoder.decode(data));
    }
    if (frame.type !== "close-stream") return;
    if (stream !== undefined)
      return this.failStream(streamId, 502, frame.reason);
    try {
      visitor?.close(relayedCloseCode(frame.code), frame.reason);
    } catch {}
  }
}
