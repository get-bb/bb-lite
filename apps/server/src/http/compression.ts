import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import type { MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { rememberRecent } from "../db/event-read.js";

type Encoding = "br" | "gzip";
type Effort = "fast" | "small";

const MIN_BYTES = 1024;
const MEMO_MIN_BYTES = 64 * 1024;
const MEMO_LIMIT = 256;
const LEVELS = { fast: { br: 4, gzip: 6 }, small: { br: 9, gzip: 9 } };
const COMPRESSIBLE = /^text\/|[/+](?:json|javascript|xml)\b|\/wasm$/u;
const UNCOMPRESSED = /\/events\/wait$/u;
const JSON_TYPE = "application/json";
const brotli = promisify(brotliCompress);
const deflate = promisify(gzip);
const memo = new Map<string, Promise<Buffer>>();

function accepted(header: string | undefined): Encoding | null {
  if (header === undefined) return null;
  if (/\bbr\b/u.test(header)) return "br";
  return /\bgzip\b/u.test(header) ? "gzip" : null;
}

function compress(data: Uint8Array, encoding: Encoding, effort: Effort) {
  const level = LEVELS[effort][encoding];
  if (encoding === "gzip") return deflate(data, { level });
  const size = { [constants.BROTLI_PARAM_SIZE_HINT]: data.byteLength };
  const params = { [constants.BROTLI_PARAM_QUALITY]: level, ...size };
  return brotli(data, { params });
}

function compressOnce(data: Uint8Array, encoding: Encoding, effort: Effort) {
  const digest = createHash("sha1").update(data).digest("base64");
  const key = `${effort}:${encoding}:${digest}`;
  const known = memo.get(key) ?? compress(data, encoding, effort);
  return rememberRecent(memo, key, known, MEMO_LIMIT);
}

export async function encodeStatic(
  content: Buffer,
  headers: Headers,
  acceptEncoding: string | undefined,
): Promise<Uint8Array<ArrayBuffer>> {
  const type = headers.get("content-type") ?? "";
  const fits = content.byteLength >= MIN_BYTES && COMPRESSIBLE.test(type);
  if (fits) headers.set("vary", "accept-encoding");
  const encoding = fits ? accepted(acceptEncoding) : null;
  if (encoding === null) return new Uint8Array(content);
  headers.set("content-encoding", encoding);
  return new Uint8Array(await compressOnce(content, encoding, "small"));
}

export const compressJson: MiddlewareHandler = (c, next) => {
  const encoding = accepted(c.req.header("accept-encoding"));
  if (encoding === null || UNCOMPRESSED.test(c.req.path)) return next();
  const plain = c.json.bind(c);
  const packed = async (value: unknown, status?: ContentfulStatusCode) => {
    const body = Buffer.from(JSON.stringify(value) ?? "");
    if (body.byteLength < MIN_BYTES) return plain(value as null, status);
    const reduce = body.byteLength < MEMO_MIN_BYTES ? compress : compressOnce;
    const sent = new Uint8Array(await reduce(body, encoding, "fast"));
    const coding = { "content-encoding": encoding, vary: "accept-encoding" };
    return c.body(sent, status, { "content-type": JSON_TYPE, ...coding });
  };
  c.json = packed as unknown as typeof c.json;
  return next();
};
