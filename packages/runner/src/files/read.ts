import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import mimeTypes from "mime-types";
import {
  fail,
  isInside,
  openRepo,
  requireSafeRef,
  type Ctx,
  type Method,
} from "../workspace/exec.js";
import {
  FILE_PAYLOAD_MAX_BYTES,
  type FileContent,
  type FileLocation,
} from "../workspace-types.js";

const BLOB_CHUNK_SOURCE_MAX_BYTES = 25 * 1024 * 1024;
const FRAME_SAFE = 700 * 1024;

type ReadTarget = FileLocation & { gitRef?: string };

interface Blob {
  oid: string;
  contents: Buffer;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function absoluteTarget(target: string, rootPath?: string): string {
  if (`${target}${rootPath ?? ""}`.includes("\0")) {
    fail("invalid_path", "Path must not contain NUL");
  }
  if (rootPath !== undefined && !path.isAbsolute(rootPath)) {
    fail("invalid_path", "rootPath must be absolute");
  }
  if (rootPath === undefined && !path.isAbsolute(target)) {
    fail("invalid_path", "A relative path needs rootPath");
  }
  return path.resolve(rootPath ?? "/", target);
}

export async function resolveRoot(rootPath?: string): Promise<string | null> {
  if (rootPath === undefined) return null;
  const stat = await fs.lstat(rootPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail("invalid_path", `Root "${rootPath}" must be a real directory`);
  }
  return fs.realpath(rootPath);
}

export function requireInsideRoot(
  realRoot: string | null,
  realTarget: string,
  label: string,
): void {
  if (realRoot !== null && !isInside(realRoot, realTarget)) {
    fail("invalid_path", `Path "${label}" escapes its root`);
  }
}

export async function confinedTarget(location: FileLocation) {
  const absolute = absoluteTarget(location.path, location.rootPath);
  const [root, target] = await Promise.all([
    resolveRoot(location.rootPath),
    fs.realpath(absolute),
  ]);
  requireInsideRoot(root, target, location.path);
  return { target, root };
}

function mimeTypeOf(target: string): string | undefined {
  return mimeTypes.lookup(target) || undefined;
}

async function readBlob(
  ctx: Ctx,
  target: ReadTarget,
  gitRef: string,
  maxBytes: number,
): Promise<Blob | null> {
  const { rootPath } = target;
  if (rootPath === undefined) {
    return fail("invalid_path", "rootPath is required with gitRef");
  }
  const absolute = absoluteTarget(target.path, rootPath);
  const relativePath = path.relative(rootPath, absolute);
  if (relativePath === "" || !isInside(rootPath, absolute)) {
    fail("invalid_path", `Path "${target.path}" escapes its root`);
  }
  const repo = openRepo(ctx, rootPath);
  const spec = `${requireSafeRef(gitRef)}:./${relativePath}`;
  const oid = await repo.line("rev-parse", "--verify", "--quiet", spec);
  if (oid === null) return null;
  const size = Number((await repo.git("cat-file", "-s", oid)).stdout);
  if (size > maxBytes) {
    fail("file_too_large", `${target.path} at ${gitRef} is ${size} bytes`);
  }
  const sized = repo.with({ maxBytes: Math.max(size, 1) });
  return { oid, contents: await sized.buffer("cat-file", "blob", oid) };
}

export async function readFileContent(ctx: Ctx, target: ReadTarget) {
  const mimeType = mimeTypeOf(target.path);
  const describe = (contents: Buffer, modifiedAtMs?: number): FileContent => {
    const image =
      mimeType?.startsWith("image/") && mimeType !== "image/svg+xml";
    const text = !image && isUtf8(contents) && contents.toString();
    const utf8 = text !== false && JSON.stringify(text).length < FRAME_SAFE;
    return {
      path: target.path,
      content: contents.toString(utf8 ? "utf8" : "base64"),
      contentEncoding: utf8 ? "utf8" : "base64",
      ...(mimeType === undefined ? {} : { mimeType }),
      ...(modifiedAtMs === undefined ? {} : { modifiedAtMs }),
      sha256: sha256Hex(contents),
      sizeBytes: contents.byteLength,
    };
  };
  if (target.gitRef !== undefined) {
    const limit = FILE_PAYLOAD_MAX_BYTES;
    const blob = await readBlob(ctx, target, target.gitRef, limit);
    return describe(blob?.contents ?? Buffer.alloc(0));
  }
  const { target: readablePath } = await confinedTarget(target);
  const stat = await fs.stat(readablePath);
  if (!stat.isFile()) fail("invalid_path", "Path is not a regular file");
  const contents =
    stat.size > FILE_PAYLOAD_MAX_BYTES ? null : await fs.readFile(readablePath);
  if (contents === null || contents.byteLength > FILE_PAYLOAD_MAX_BYTES) {
    const hint = `read it in chunks of ${FILE_PAYLOAD_MAX_BYTES} bytes`;
    return fail("file_too_large", `${target.path} is too large; ${hint}`);
  }
  return describe(contents, stat.mtimeMs);
}

export const readFile: Method<"readFile"> = async (ctx, args) => {
  const { content, ...metadata } = await readFileContent(ctx, args);
  return args.ifNoneMatch?.includes(metadata.sha256)
    ? { ...metadata, notModified: true }
    : { ...metadata, content };
};

function fileRevision(stat: BigIntStats): string {
  const { dev, ino, size, mtimeNs, ctimeNs } = stat;
  return sha256Hex([dev, ino, size, mtimeNs, ctimeNs].join(":"));
}

function requireUnchanged(expected: string | null, revision: string): void {
  if (expected !== null && expected !== revision) {
    fail("conflict", "File changed during read", true);
  }
}

export const readFileChunk: Method<"readFileChunk"> = async (ctx, args) => {
  const { offset } = args;
  const natural = (value: number) => Number.isSafeInteger(value) && value >= 0;
  const valid = natural(offset) && natural(args.length);
  if (!valid || args.length > FILE_PAYLOAD_MAX_BYTES) {
    fail("failed", `A chunk is at most ${FILE_PAYLOAD_MAX_BYTES} bytes`);
  }
  const mimeType = mimeTypeOf(args.path) ?? null;
  const chunk = { path: args.path, mimeType, offset };
  if (args.gitRef !== undefined) {
    const limit = BLOB_CHUNK_SOURCE_MAX_BYTES;
    const blob = await readBlob(ctx, args, args.gitRef, limit);
    const contents = blob?.contents ?? Buffer.alloc(0);
    const revision = sha256Hex(`blob:${blob?.oid ?? ""}`);
    requireUnchanged(args.revision, revision);
    const bytes = contents.subarray(offset, offset + args.length);
    const dataBase64 = bytes.toString("base64");
    const sizeBytes = contents.byteLength;
    return { ...chunk, sizeBytes, modifiedAtMs: null, revision, dataBase64 };
  }
  const flags =
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const file = await fs.open((await confinedTarget(args)).target, flags);
  try {
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile() || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      fail("invalid_path", "Path is not a readable file");
    }
    const revision = fileRevision(stat);
    requireUnchanged(args.revision, revision);
    const sizeBytes = Number(stat.size);
    const length = Math.min(args.length, Math.max(0, sizeBytes - offset));
    const bytes = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const position = offset + filled;
      const read = await file.read(bytes, filled, length - filled, position);
      if (read.bytesRead === 0) break;
      filled += read.bytesRead;
    }
    const after = fileRevision(await file.stat({ bigint: true }));
    requireUnchanged(revision, filled === length ? after : "");
    const modifiedAtMs = Number(stat.mtimeNs) / 1_000_000;
    const dataBase64 = bytes.toString("base64");
    return { ...chunk, sizeBytes, modifiedAtMs, revision, dataBase64 };
  } finally {
    await file.close();
  }
};
