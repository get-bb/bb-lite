import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

interface ByteRange {
  start: number;
  end: number;
}

interface ByteSelection extends ByteRange {
  status: 200 | 206;
}

const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/u;

function parseSingleRange(
  header: string | undefined,
  size: number,
): ByteRange | "unsatisfiable" | null {
  const match = SINGLE_RANGE.exec(header?.trim() ?? "");
  if (match === null) return null;
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return null;
  if (first === "") {
    const length = Math.min(Number(last), size);
    return length === 0
      ? "unsatisfiable"
      : { start: size - length, end: size - 1 };
  }
  const start = Number(first);
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  return start >= size || end < start ? "unsatisfiable" : { start, end };
}

export function matchesEntityTag(
  header: string | null | undefined,
  etag: string,
): boolean {
  const opaque = (tag: string) => tag.trim().replace(/^W\//u, "");
  const wanted = header?.split(",").map(opaque) ?? [];
  return wanted.includes("*") || wanted.includes(opaque(etag));
}

export function selectRange(
  headers: Headers,
  header: string | undefined,
  size: number,
): ByteSelection | null {
  const range = parseSingleRange(header, size);
  if (range === "unsatisfiable") {
    headers.set("content-range", `bytes */${size}`);
    return null;
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  headers.set("content-length", String(end - start + 1));
  if (range === null) return { start, end, status: 200 };
  headers.set("content-range", `bytes ${start}-${end}/${size}`);
  return { start, end, status: 206 };
}

export async function fileResponse(
  path: string,
  options: {
    range: string | undefined;
    ifNoneMatch: string | undefined;
    contentType: string;
    cacheControl: string;
  },
): Promise<Response | null> {
  const file = await stat(path).catch(() => null);
  if (file === null || !file.isFile()) return null;
  const { size } = file;
  const etag = `"${size.toString(16)}-${Math.floor(file.mtimeMs).toString(16)}"`;
  const headers = new Headers({
    "accept-ranges": "bytes",
    "cache-control": options.cacheControl,
    "content-type": options.contentType,
    etag,
  });
  if (options.ifNoneMatch?.split(",").some((tag) => tag.trim() === etag)) {
    return new Response(null, { status: 304, headers });
  }
  const selected = selectRange(headers, options.range, size);
  if (selected === null) return new Response(null, { status: 416, headers });
  const { start, end, status } = selected;
  if (size === 0) return new Response(null, { status, headers });
  const body = Readable.toWeb(createReadStream(path, { start, end }));
  return new Response(body as ReadableStream<Uint8Array>, { status, headers });
}
