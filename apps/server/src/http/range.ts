import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

export interface ByteRange {
  start: number;
  end: number;
}

export interface FileResponseOptions {
  range: string | undefined;
  ifNoneMatch: string | undefined;
  contentType: string;
  cacheControl: string;
}

const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/u;

export function parseSingleRange(
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

export async function fileResponse(
  path: string,
  options: FileResponseOptions,
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
  const range = parseSingleRange(options.range, size);
  if (range === "unsatisfiable") {
    headers.set("content-range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  headers.set("content-length", String(end - start + 1));
  if (range !== null) {
    headers.set("content-range", `bytes ${start}-${end}/${size}`);
  }
  const status = range === null ? 200 : 206;
  if (size === 0) return new Response(null, { status, headers });
  const body = Readable.toWeb(createReadStream(path, { start, end }));
  return new Response(body as ReadableStream<Uint8Array>, { status, headers });
}
