import { WebSocket } from "ws";
import {
  LEASE_MS,
  PING_INTERVAL_MS,
  createFrameDecoder,
  encodeFrame,
  type WholeFrame,
} from "./protocol.js";

export type PayloadFrame = Exclude<WholeFrame, { t: "ping" | "pong" }>;

export interface FrameLinkOptions {
  pings: boolean;
  onFrame(frame: PayloadFrame): void;
  onClosed(): void;
}

export interface FrameLink {
  send(frame: WholeFrame, written?: () => void): void;
}

export function linkFrames(
  socket: WebSocket,
  options: FrameLinkOptions,
): FrameLink {
  const decode = createFrameDecoder();
  let heardAt = Date.now();
  let closed = false;
  const send = (frame: WholeFrame, written?: () => void) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    for (const part of encodeFrame(frame)) socket.send(part, written);
  };
  const beat = setInterval(() => {
    if (Date.now() - heardAt > LEASE_MS) socket.terminate();
    else if (options.pings) send({ t: "ping" });
  }, PING_INTERVAL_MS);
  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(beat);
    options.onClosed();
  };
  socket.on("message", (data) => {
    heardAt = Date.now();
    const frame = decode(String(data));
    if (frame === null || frame.t === "pong") return;
    if (frame.t === "ping") send({ t: "pong" });
    else options.onFrame(frame);
  });
  socket.on("close", finish);
  socket.on("error", () => {
    socket.terminate();
    finish();
  });
  return { send };
}
