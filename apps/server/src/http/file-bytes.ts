import { posix } from "node:path";
import {
  FILE_PAYLOAD_MAX_BYTES,
  RunnerError,
  type FileChunk,
  type RunnerErrorCode,
} from "@bb/runner";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ServerContext } from "../context.js";
import { ApiError } from "./errors.js";
import { matchesEntityTag, selectRange } from "./range.js";

export interface FileBytesTarget {
  hostId: string;
  rootPath: string;
  segments: string[];
  gitRef?: string;
}

const REVISION_REF = /^(?:HEAD|[0-9a-f]{4,40})$/iu;
const FILE_ERROR_STATUS: Partial<
  Record<RunnerErrorCode, ContentfulStatusCode>
> = { invalid_path: 400, permission_denied: 403, file_too_large: 413 };

function fileChanged(): ApiError {
  const message = "File changed during read; retry the request";
  return new ApiError(409, "file_changed", message, { retryable: true });
}

function rethrowFileError(error: unknown): never {
  if (!(error instanceof RunnerError)) throw error;
  if (error.code === "conflict") throw fileChanged();
  const status = FILE_ERROR_STATUS[error.code];
  if (status === undefined) throw error;
  throw new ApiError(status, error.code, error.message, { retryable: false });
}

export function relativeFileSegments(rawPath: string): string[] {
  const segments = rawPath.replace(/\\/gu, "/").split("/");
  const unsafe = segments.some((segment) => ["", ".", ".."].includes(segment));
  if (unsafe || rawPath.includes("\0")) {
    throw new ApiError(400, "invalid_path", "Invalid file path", {
      retryable: false,
    });
  }
  return segments;
}

export function revisionRef(ref: string): string {
  if (REVISION_REF.test(ref)) return ref;
  throw new ApiError(400, "invalid_ref", "Invalid revision");
}

function rawFileHeaders(file: FileChunk): Headers {
  const mimeType = file.mimeType ?? "application/octet-stream";
  const html = mimeType.split(";")[0]?.trim().toLowerCase() === "text/html";
  const headers = new Headers({
    "accept-ranges": "bytes",
    "cache-control": html ? "no-store" : "private, no-cache",
    "content-security-policy": "sandbox allow-scripts",
    "content-type": html ? "text/html; charset=utf-8" : mimeType,
    etag: `W/"file-${file.revision}"`,
    "x-content-type-options": "nosniff",
  });
  if (file.modifiedAtMs !== null) {
    headers.set("last-modified", new Date(file.modifiedAtMs).toUTCString());
  }
  return headers;
}

export async function serveFileBytes(
  ctx: ServerContext,
  request: Request,
  target: FileBytesTarget,
): Promise<Response> {
  const runner = ctx.runners.get(target.hostId);
  const { rootPath, gitRef } = target;
  const path = posix.join(rootPath, ...target.segments);
  const read = (offset: number, length: number, revision: string | null) =>
    runner
      .readFileChunk({ path, rootPath, gitRef, offset, length, revision })
      .catch(rethrowFileError);
  const file = await read(0, 0, null);
  const size = file.sizeBytes;
  const headers = rawFileHeaders(file);
  const revalidates = headers.get("cache-control") !== "no-store";
  const etag = headers.get("etag") ?? "";
  if (
    revalidates &&
    matchesEntityTag(request.headers.get("if-none-match"), etag)
  ) {
    return new Response(null, { status: 304, headers });
  }
  const ranged = request.method === "GET" && !request.headers.has("if-range");
  const wanted = request.headers.get("range") ?? undefined;
  const selected = selectRange(headers, ranged ? wanted : undefined, size);
  if (selected === null) {
    headers.set("content-length", "0");
    return new Response(null, { status: 416, headers });
  }
  const { start, end, status } = selected;
  if (request.method === "HEAD" || size === 0) {
    return new Response(null, { status, headers });
  }
  const readBytes = async (offset: number): Promise<Buffer> => {
    request.signal.throwIfAborted();
    const length = Math.min(FILE_PAYLOAD_MAX_BYTES, end - offset + 1);
    const chunk = await read(offset, length, file.revision);
    const bytes = Buffer.from(chunk.dataBase64, "base64");
    const intact = chunk.revision === file.revision && bytes.length === length;
    if (!intact) throw fileChanged();
    return bytes;
  };
  let next = start;
  let first: Buffer | null = await readBytes(next);
  let cancelled = false;
  const source: UnderlyingDefaultSource<Uint8Array> = {
    async pull(controller) {
      const bytes = first ?? (await readBytes(next));
      first = null;
      if (cancelled) return;
      next += bytes.length;
      controller.enqueue(bytes);
      if (next > end) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  };
  const body = new ReadableStream(source, { highWaterMark: 0 });
  return new Response(body, { status, headers });
}
