import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { pathLooksRuntimeReadable, type PromptInput } from "@bb/domain";
import type { ServerContext, ServerRunner } from "../context.js";
import type { ThreadRow } from "../db/threads.js";
import { resolveAttachmentPath } from "../projects/attachments.js";

interface AttachmentTarget {
  hostId: string;
  runner: ServerRunner;
  thread: ThreadRow;
}

type FileInput = Extract<PromptInput, { type: "localImage" | "localFile" }>;

const CHUNK_BYTES = 4 * 1024 * 1024;

function isStored(part: PromptInput): part is FileInput {
  const file = part.type === "localImage" || part.type === "localFile";
  return file && !pathLooksRuntimeReadable(part.path);
}

async function copyToHost(runner: ServerRunner, source: string, path: string) {
  const bytes = await readFile(source);
  let offset = 0;
  do {
    const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
    const dataBase64 = chunk.toString("base64");
    const write = { path, offset, dataBase64, createParents: true };
    await runner.writeFileChunk(write);
    offset += CHUNK_BYTES;
  } while (offset < bytes.byteLength);
}

export async function deliverAttachments(
  ctx: ServerContext,
  { hostId, runner, thread }: AttachmentTarget,
  input: PromptInput[],
): Promise<PromptInput[]> {
  if (!input.some(isStored)) return input;
  const { dataDir, hostId: localHostId } = ctx.config;
  const root =
    hostId === localHostId ? null : (await runner.describe()).threadStorageRoot;
  const delivered: PromptInput[] = [];
  for (const part of input) {
    if (!isStored(part)) {
      delivered.push(part);
      continue;
    }
    const source = resolveAttachmentPath(dataDir, thread.projectId, part.path);
    if (root === null) {
      delivered.push({ ...part, path: source });
      continue;
    }
    const name = basename(part.path);
    const path = `${root}/${thread.id}/attachments/${name}`;
    await copyToHost(runner, source, path);
    delivered.push({ ...part, path });
  }
  return delivered;
}
