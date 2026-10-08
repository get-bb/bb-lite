import { randomBytes } from "node:crypto";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import {
  canonicalProjectAttachmentPath,
  ProjectAttachmentError,
  PROMPT_ATTACHMENT_MAX_BYTES,
} from "@bb/domain";
import type { UploadedPromptAttachment } from "@bb/server-contract";
import { lookup } from "mime-types";
import { dataPaths } from "../config.js";
import type { ServerContext } from "../context.js";
import { newId, type Db } from "../db/index.js";
import { invalidRequest, notFound } from "../http/errors.js";

interface AttachmentRecord {
  projectId: string;
  storedPath: string;
  originalName: string;
  mimeType: string | null;
  sizeBytes: number;
}

const HEIF_MIME_TYPES = /^image\/hei[cf](-sequence)?$/u;
const MEBIBYTE = 1024 * 1024;

export function projectAttachmentsDir(dataDir: string, projectId: string) {
  return join(dataPaths(dataDir).attachments, projectId);
}

export function resolveAttachmentPath(
  dataDir: string,
  projectId: string,
  storedName: string,
): string {
  try {
    const relative = canonicalProjectAttachmentPath(storedName);
    return join(projectAttachmentsDir(dataDir, projectId), relative);
  } catch (error) {
    if (error instanceof ProjectAttachmentError) {
      throw invalidRequest(error.message);
    }
    throw error;
  }
}

export function attachmentMimeType(path: string): string | null {
  return lookup(path) || null;
}

function storedNameFor(originalName: string, now: number) {
  const sanitized = basename(originalName).replace(/[^a-zA-Z0-9._-]+/gu, "-");
  const extension = extname(sanitized);
  const stem = sanitized.slice(0, sanitized.length - extension.length);
  const suffix = randomBytes(3).toString("hex");
  return `${stem || "attachment"}-${now}-${suffix}${extension}`;
}

function megabytes(bytes: number) {
  return String(Math.round((bytes / MEBIBYTE) * 10) / 10);
}

function recordAttachment(db: Db, record: AttachmentRecord) {
  db.run(
    `INSERT INTO project_attachments
       (id, project_id, stored_path, original_name, mime_type, size_bytes,
        created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    newId("att"),
    record.projectId,
    record.storedPath,
    record.originalName,
    record.mimeType,
    record.sizeBytes,
    db.now(),
  );
}

export async function storeAttachment(
  ctx: ServerContext,
  projectId: string,
  file: File,
): Promise<UploadedPromptAttachment> {
  const mimeType = file.type.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (HEIF_MIME_TYPES.test(mimeType)) {
    throw invalidRequest(
      "HEIC images are not supported. Convert the image to JPEG or PNG " +
        "before attaching it.",
    );
  }
  if (file.size > PROMPT_ATTACHMENT_MAX_BYTES) {
    const limit = megabytes(PROMPT_ATTACHMENT_MAX_BYTES);
    throw invalidRequest(
      `${file.name} is ${megabytes(file.size)}MB, over the ${limit}MB ` +
        "attachment limit",
    );
  }
  const storedPath = storedNameFor(file.name, ctx.now());
  const { dataDir } = ctx.config;
  const target = resolveAttachmentPath(dataDir, projectId, storedPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, Buffer.from(await file.arrayBuffer()), {
    flag: "wx",
  });
  recordAttachment(ctx.db, {
    projectId,
    storedPath,
    originalName: file.name,
    mimeType: file.type || null,
    sizeBytes: file.size,
  });
  return {
    type: mimeType.startsWith("image/") ? "localImage" : "localFile",
    path: storedPath,
    name: file.name,
    ...(file.type === "" ? {} : { mimeType: file.type }),
    sizeBytes: file.size,
  };
}

export async function copyAttachments(
  ctx: ServerContext,
  from: string,
  to: string,
  paths: string[],
): Promise<void> {
  if (from === to) return;
  const { dataDir } = ctx.config;
  for (const storedPath of new Set(paths)) {
    const source = resolveAttachmentPath(dataDir, from, storedPath);
    const target = resolveAttachmentPath(dataDir, to, storedPath);
    const file = await stat(source).catch(() => null);
    if (file === null || !file.isFile()) throw notFound("Attachment not found");
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    recordAttachment(ctx.db, {
      projectId: to,
      storedPath: canonicalProjectAttachmentPath(storedPath),
      originalName: basename(storedPath),
      mimeType: attachmentMimeType(storedPath),
      sizeBytes: file.size,
    });
  }
}
