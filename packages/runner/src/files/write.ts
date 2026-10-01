import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fail, unlessCode, type Method } from "../workspace/exec.js";
import {
  FILE_PAYLOAD_MAX_BYTES,
  type FileLocation,
  type FileWriteResult,
} from "../workspace-types.js";
import {
  absoluteTarget,
  requireInsideRoot,
  resolveRoot,
  sha256Hex,
} from "./read.js";

async function resolveWriteTarget(
  target: string,
): Promise<{ writePath: string; parentMissing: boolean }> {
  const missing: string[] = [];
  for (let ancestor = target; ; ancestor = path.dirname(ancestor)) {
    const real = await fs.realpath(ancestor).catch(unlessCode("ENOENT", null));
    if (real !== null) {
      const writePath = path.join(real, ...missing);
      return { writePath, parentMissing: missing.length > 1 };
    }
    if (path.dirname(ancestor) === ancestor) {
      fail("path_not_found", `Path does not exist: ${target}`);
    }
    missing.unshift(path.basename(ancestor));
  }
}

async function confinedWritePath(
  location: FileLocation,
): Promise<{ writePath: string; parentMissing: boolean }> {
  const absolute = absoluteTarget(location.path, location.rootPath);
  const [target, realRoot] = await Promise.all([
    resolveWriteTarget(absolute),
    resolveRoot(location.rootPath),
  ]);
  requireInsideRoot(realRoot, target.writePath, location.path);
  return target;
}

async function writableFile(
  location: FileLocation & { createParents?: boolean },
): Promise<string> {
  const { writePath, parentMissing } = await confinedWritePath(location);
  const parent = path.dirname(writePath);
  if (location.createParents === true) {
    await fs.mkdir(parent, { recursive: true });
  } else if (parentMissing) {
    fail("path_not_found", `Path does not exist: ${parent}`);
  }
  return writePath;
}

function decodePayload(content: string, encoding: BufferEncoding): Buffer {
  const contents = Buffer.from(content, encoding);
  if (contents.byteLength > FILE_PAYLOAD_MAX_BYTES) {
    const limit = `${FILE_PAYLOAD_MAX_BYTES} bytes`;
    fail("file_too_large", `A write carries at most ${limit}; send chunks`);
  }
  return contents;
}

async function currentSha256(target: string): Promise<string | null> {
  const contents = await fs.readFile(target).catch(unlessCode("ENOENT", null));
  return contents === null ? null : sha256Hex(contents);
}

async function replaceIfUnchanged(
  target: string,
  contents: Buffer,
  mode: number | undefined,
  expectedSha256: string | null,
): Promise<FileWriteResult | null> {
  const temporaryPath = `${target}.bb-write-${randomUUID()}`;
  const conflict = async (): Promise<FileWriteResult> => ({
    outcome: "conflict",
    currentSha256: await currentSha256(target),
  });
  try {
    const handle = await fs.open(temporaryPath, "wx", mode);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (expectedSha256 === null) {
      const linked = await fs
        .link(temporaryPath, target)
        .then(() => true, unlessCode("EEXIST", false));
      return linked ? null : await conflict();
    }
    if ((await currentSha256(target)) !== expectedSha256) {
      return await conflict();
    }
    await fs.rename(temporaryPath, target);
    return null;
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

export const writeFile: Method<"writeFile"> = async (ctx, args) => {
  const contents = decodePayload(args.content, args.contentEncoding ?? "utf8");
  const target = await writableFile(args);
  return ctx.lock(`file:${target}`, async () => {
    const stat = await fs.stat(target).catch(() => null);
    if (stat?.isDirectory()) {
      fail("invalid_path", "Path is a directory, not a file");
    }
    const mode = args.mode ?? (stat === null ? undefined : stat.mode & 0o777);
    if (args.expectedSha256 === undefined) {
      await fs.writeFile(target, contents, { mode });
    } else {
      const existing = await currentSha256(target);
      const conflict: FileWriteResult | null =
        existing === args.expectedSha256
          ? await replaceIfUnchanged(target, contents, mode, existing)
          : { outcome: "conflict", currentSha256: existing };
      if (conflict !== null) {
        return conflict;
      }
    }
    const sizeBytes = contents.byteLength;
    return { outcome: "written", sha256: sha256Hex(contents), sizeBytes };
  });
};

export const writeFileChunk: Method<"writeFileChunk"> = async (ctx, args) => {
  const contents = decodePayload(args.dataBase64, "base64");
  const { offset } = args;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    fail("failed", "offset must be a non-negative integer");
  }
  const target = await writableFile(args);
  return ctx.lock(`file:${target}`, async () => {
    const handle = await fs.open(target, offset === 0 ? "w" : "r+", args.mode);
    try {
      const { size } = await handle.stat();
      if (offset > size) {
        fail("conflict", `Chunk offset ${offset} is past the end (${size})`);
      }
      await handle.write(contents, 0, contents.byteLength, offset);
      return { sizeBytes: Math.max(size, offset + contents.byteLength) };
    } finally {
      await handle.close();
    }
  });
};

async function existingTarget(location: FileLocation): Promise<{
  target: string;
  root: string | null;
}> {
  const absolute = absoluteTarget(location.path, location.rootPath);
  if ((await fs.lstat(absolute)).isSymbolicLink()) {
    fail("invalid_path", `Path "${location.path}" must not be a symlink`);
  }
  const [target, root] = await Promise.all([
    fs.realpath(absolute),
    resolveRoot(location.rootPath),
  ]);
  requireInsideRoot(root, target, location.path);
  return { target, root };
}

export const mutatePath: Method<"mutatePath"> = async (_ctx, args) => {
  if (args.op === "mkdir") {
    const { writePath } = await confinedWritePath(args);
    await fs.mkdir(writePath, { recursive: args.recursive === true });
  } else if (args.op === "move") {
    const { rootPath } = args;
    const source = await existingTarget({ path: args.sourcePath, rootPath });
    const absolute = absoluteTarget(args.destinationPath, rootPath);
    const parent = await fs.realpath(path.dirname(absolute));
    const destination = path.join(parent, path.basename(absolute));
    requireInsideRoot(source.root, destination, args.destinationPath);
    if ((await fs.lstat(destination).catch(() => null)) !== null) {
      fail("conflict", `Destination already exists: ${args.destinationPath}`);
    }
    await fs.rename(source.target, destination);
  } else {
    const { target, root } = await existingTarget(args);
    if (target === root) {
      fail("invalid_path", "Cannot remove the declared root");
    }
    const recursive = args.recursive === true;
    if ((await fs.lstat(target)).isDirectory() && !recursive) {
      await fs.rmdir(target);
    } else {
      await fs.rm(target, { recursive });
    }
  }
  return { ok: true };
};
