import * as http from "node:http";
import * as wire from "@bb/tunnel-contract";
import { WebSocket as NodeWebSocket } from "ws";

const DEFAULT_HEARTBEAT = { intervalMs: 20_000, deadlineMs: 60_000 };
const HEARTBEAT_LATE_TICK_GRACE_MS = 5_000;
const UNREGISTERED_PORT_BODY = "this port is not shared";
const VIA_TUNNEL_HEADER = "x-bb-via-tunnel";
const SKIP_REQUEST_HEADERS = ["host", "content-length", "connection"];

function headersForLoopbackRequest(
  headers: wire.HeaderPair[],
  target: ResolvedStreamOrigin,
  marker: string,
): Record<string, string> {
  const loopbackOrigin = new URL(target.origin).origin;
  const skipped = [...SKIP_REQUEST_HEADERS, VIA_TUNNEL_HEADER];
  const forwarded: Record<string, string> = {};
  for (const [name, value] of headers) {
    const lowerName = name.toLowerCase();
    if (skipped.includes(lowerName)) continue;
    const publicOrigin =
      lowerName === "origin" && value === target.publicOrigin;
    forwarded[name] = publicOrigin ? loopbackOrigin : value;
  }
  if (target.host === undefined) forwarded[VIA_TUNNEL_HEADER] = marker;
  else forwarded.Host = target.host;
  return forwarded;
}

function requestOriginHttp(
  url: URL,
  options: http.RequestOptions,
  body: Buffer | undefined,
): Promise<http.IncomingMessage> {
  const length = body && { "Content-Length": String(body.byteLength) };
  const headers = { ...options.headers, ...length };
  return new Promise<http.IncomingMessage>((resolve, reject) => {
    const originRequest = http.request(url, { ...options, headers }, resolve);
    originRequest.once("error", reject);
    originRequest.end(body);
  });
}

function responseHeaderPairs(
  response: http.IncomingMessage,
): wire.HeaderPair[] {
  const raw = response.rawHeaders;
  return raw.flatMap((name, index) => {
    const value = raw[index + 1];
    return index % 2 === 0 && value !== undefined ? [[name, value]] : [];
  });
}

interface HttpStream {
  meta: wire.OpenHttpFrame;
  chunks: Buffer[];
  abort: AbortController;
}
interface WsStream {
  socket: NodeWebSocket;
  buffered: wire.Frame[];
  open: boolean;
}

interface ResolvedStreamOrigin {
  origin: string;
  publicOrigin: string;
  host?: string;
}

export type StreamOriginResult =
  | { kind: "ok"; resolved: ResolvedStreamOrigin }
  | { kind: "unregistered" };

interface TunnelSessionOptions {
  tunnel: NodeWebSocket;
  log: { info?(message: string): void; warn(message: string): void };
  resolveOrigin: (target: string | undefined) => StreamOriginResult;
  marker: string;
  heartbeat?: { intervalMs: number; deadlineMs: number };
}

export class TunnelSession {
  private readonly httpStreams = new Map<number, HttpStream>();
  private readonly wsStreams = new Map<number, WsStream>();
  private lastAck = Date.now();
  private lastHeartbeatTickAt = 0;
  private stallGraceSinceAck = false;
  private heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: TunnelSessionOptions) {}

  start(): void {
    const { tunnel } = this.options;
    const { intervalMs, deadlineMs } =
      this.options.heartbeat ?? DEFAULT_HEARTBEAT;
    const lateTickMs = intervalMs + HEARTBEAT_LATE_TICK_GRACE_MS;
    this.lastAck = Date.now();
    this.lastHeartbeatTickAt = performance.now();
    this.heartbeat = setInterval(() => {
      const tickGapMs = performance.now() - this.lastHeartbeatTickAt;
      this.lastHeartbeatTickAt += tickGapMs;
      if (tickGapMs > lateTickMs && !this.stallGraceSinceAck) {
        this.options.log.warn("event loop stalled; restarting the deadline");
        this.lastAck = Date.now();
        this.stallGraceSinceAck = true;
      } else if (Date.now() - this.lastAck > deadlineMs) {
        this.options.log.warn("tunnel heartbeat missed; reconnecting");
        return tunnel.terminate();
      }
      tunnel.send(wire.HEARTBEAT_REQUEST);
    }, intervalMs);

    tunnel.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        if (data.toString() === wire.HEARTBEAT_RESPONSE) {
          this.lastAck = Date.now();
          this.stallGraceSinceAck = false;
        }
        return;
      }
      try {
        this.onFrame(wire.decodeFrame(data));
      } catch (e) {
        this.options.log.warn(`tunnel bad frame: ${String(e)}`);
      }
    });
    tunnel.on("close", () => this.dispose());
  }

  dispose(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const s of this.httpStreams.values()) s.abort.abort();
    for (const s of this.wsStreams.values())
      s.socket.close(1001, "tunnel closed");
    this.httpStreams.clear();
    this.wsStreams.clear();
  }

  private send(frame: wire.Frame): void {
    if (this.options.tunnel.readyState === NodeWebSocket.OPEN) {
      this.options.tunnel.send(wire.encodeFrame(frame));
    }
  }

  private closeStream(streamId: number, code: number, reason: string): void {
    this.send({ type: "close-stream", streamId, code, reason });
  }

  private onFrame(frame: wire.Frame): void {
    switch (frame.type) {
      case "open-http": {
        const stream: HttpStream = {
          meta: frame,
          chunks: [],
          abort: new AbortController(),
        };
        this.httpStreams.set(frame.streamId, stream);
        if (!frame.hasBody) void this.executeHttp(frame.streamId, stream);
        return;
      }
      case "body-chunk":
        this.httpStreams
          .get(frame.streamId)
          ?.chunks.push(Buffer.from(frame.data));
        return;
      case "body-end": {
        const s = this.httpStreams.get(frame.streamId);
        if (s) void this.executeHttp(frame.streamId, s);
        return;
      }
      case "open-ws":
        this.openOriginWs(frame);
        return;
      case "ws-data": {
        const s = this.wsStreams.get(frame.streamId);
        if (!s) return;
        if (!s.open) {
          s.buffered.push(frame);
          return;
        }
        s.socket.send(
          frame.isBinary ? frame.data : Buffer.from(frame.data).toString(),
        );
        return;
      }
      case "close-stream": {
        const h = this.httpStreams.get(frame.streamId);
        if (h) {
          h.abort.abort();
          this.httpStreams.delete(frame.streamId);
          return;
        }
        const w = this.wsStreams.get(frame.streamId);
        if (w) {
          w.socket.close(frame.code, frame.reason);
          this.wsStreams.delete(frame.streamId);
        }
        return;
      }
      case "resp-head":
      case "ws-open-ack":
        return;
    }
  }

  private async executeHttp(
    streamId: number,
    stream: HttpStream,
  ): Promise<void> {
    const { meta } = stream;
    const originResult = this.options.resolveOrigin(meta.target);
    if (originResult.kind === "unregistered") {
      const headers: wire.HeaderPair[] = [
        ["content-type", "text/plain; charset=utf-8"],
      ];
      const data = Buffer.from(UNREGISTERED_PORT_BODY);
      this.send({ type: "resp-head", streamId, status: 404, headers });
      this.send({ type: "body-chunk", streamId, data });
      this.send({ type: "body-end", streamId });
      this.httpStreams.delete(streamId);
      return;
    }
    const { resolved } = originResult;
    const { marker } = this.options;
    const headers = headersForLoopbackRequest(meta.headers, resolved, marker);
    const { signal } = stream.abort;
    try {
      const body = meta.hasBody ? Buffer.concat(stream.chunks) : undefined;
      const url = new URL(`${resolved.origin.replace(/\/$/u, "")}${meta.path}`);
      const options = { method: meta.method, headers, signal };
      const res = await requestOriginHttp(url, options, body);
      this.send({
        type: "resp-head",
        streamId,
        status: res.statusCode ?? 502,
        headers: responseHeaderPairs(res),
      });
      for await (const chunk of res) {
        const value =
          chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk));
        for (const frame of wire.chunkBody(streamId, value)) this.send(frame);
      }
      this.send({ type: "body-end", streamId });
    } catch (e) {
      if (!signal.aborted) {
        this.options.log.warn(
          `origin http error on ${meta.method} ${meta.path.split("?")[0]}: ${String(e)}`,
        );
        this.closeStream(streamId, 1011, String(e));
      }
    } finally {
      this.httpStreams.delete(streamId);
    }
  }

  private openOriginWs(frame: wire.OpenWsFrame): void {
    const originResult = this.options.resolveOrigin(frame.target);
    const { streamId } = frame;
    if (originResult.kind === "unregistered") {
      return this.closeStream(streamId, 1008, UNREGISTERED_PORT_BODY);
    }
    const { resolved } = originResult;
    const url = `${resolved.origin.replace(/^http/, "ws")}${frame.path}`;
    const { marker } = this.options;
    const headers = headersForLoopbackRequest(frame.headers, resolved, marker);
    let socket: NodeWebSocket;
    try {
      socket = new NodeWebSocket(url, frame.protocols, { headers });
    } catch (e) {
      return this.closeStream(streamId, 1011, String(e));
    }
    const stream: WsStream = { socket, buffered: [], open: false };
    this.wsStreams.set(streamId, stream);

    socket.on("open", () => {
      stream.open = true;
      const protocol = socket.protocol || null;
      this.send({ type: "ws-open-ack", streamId, protocol });
      for (const b of stream.buffered) this.onFrame(b);
      stream.buffered = [];
    });
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      const bytes = isBinary ? data : Buffer.from(data.toString());
      const frameData = new Uint8Array(bytes);
      this.send({ type: "ws-data", streamId, isBinary, data: frameData });
    });
    socket.on("close", (code: number, reason: Buffer) => {
      const relayed = code === 1000 || (code >= 3000 && code <= 4999);
      if (this.wsStreams.delete(streamId)) {
        this.closeStream(streamId, relayed ? code : 1000, reason.toString());
      }
    });
    socket.on("error", (e: Error) => {
      const path = frame.path.split("?")[0];
      this.options.log.warn(`origin ws error on ${path}: ${e.message}`);
    });
  }
}
