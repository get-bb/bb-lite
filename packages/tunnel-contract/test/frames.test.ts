import { expect, it } from "vitest";
import {
  chunkBody,
  decodeFrame,
  encodeFrame,
  MAX_CHUNK_BYTES,
  type Frame,
  type HeaderPair,
} from "../src/index.js";

const headers: HeaderPair[] = [["cookie", "a=b; ✓"]];
const post = { method: "POST", path: "/a?b=1", headers, hasBody: true };
const get = { method: "GET", path: "/", headers: [], hasBody: false };
const upgrade = { path: "/ws", headers, protocols: ["bb.v1"] };
const data = Uint8Array.from({ length: 1000 }, (_value, index) => index % 256);
const frames: Frame[] = [
  { type: "open-http", streamId: 7, ...post },
  { type: "open-http", streamId: 8, ...get, target: "8000" },
  { type: "body-chunk", streamId: 0xffffffff, data },
  { type: "body-end", streamId: 0 },
  { type: "resp-head", streamId: 12, status: 204, headers },
  { type: "open-ws", streamId: 20, ...upgrade },
  { type: "open-ws", streamId: 21, ...upgrade, target: "3000" },
  { type: "ws-open-ack", streamId: 20, protocol: null },
  { type: "ws-data", streamId: 20, isBinary: true, data },
  { type: "ws-data", streamId: 20, isBinary: false, data: data.subarray(0, 0) },
  { type: "close-stream", streamId: 20, code: 1008, reason: "not shared" },
];

it("round-trips every frame type", () => {
  for (const frame of frames) {
    const encoded = encodeFrame(frame);
    expect(decodeFrame(encoded)).toEqual(frame);
    expect(decodeFrame(encoded.slice().buffer)).toEqual(frame);
  }
});

it("keeps the wire layout: type byte, big-endian stream id, payload", () => {
  const types = frames.map((frame) => encodeFrame(frame)[0]);
  expect(types).toEqual([1, 1, 2, 3, 4, 5, 5, 6, 7, 7, 8]);
  const end = encodeFrame({ type: "body-end", streamId: 0x01020304 });
  expect([...end]).toEqual([3, 1, 2, 3, 4]);
  const [open] = frames.map((frame) => encodeFrame(frame).subarray(5));
  expect(new TextDecoder().decode(open)).toBe(JSON.stringify(post));
  const oversized = new Uint8Array(2 * MAX_CHUNK_BYTES + 1);
  const sizes = [...chunkBody(1, oversized)].map((part) => part.data.length);
  expect(sizes).toEqual([MAX_CHUNK_BYTES, MAX_CHUNK_BYTES, 1]);
});
