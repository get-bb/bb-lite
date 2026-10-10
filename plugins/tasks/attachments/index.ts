import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { publish, type TasksContext } from "../api/index.js";
import type { StoredAttachment } from "../db/store.js";
import {
  attachmentDownloadUrl,
  MAX_ATTACHMENT_SIZE_BYTES,
} from "../shared/contract.js";

export interface AttachmentOwner {
  taskId: string | null;
  commentId: string | null;
}

const RASTER_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
};
const INLINE_MIMES = new Set(Object.values(RASTER_MIME_BY_EXTENSION));
const MIME_PATTERN =
  /^(application|audio|font|image|message|model|multipart|text|video)\/[!#$&^_.+\-A-Za-z0-9]+$/u;
const UNSAFE_NAME_CHARACTERS = /[\u0000-\u001f\u007f<>:"|?*؜‎‏‪-‮⁦-⁩]/gu;

class AttachmentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function safeFileName(fileName: string): string {
  const base = fileName.normalize("NFC").split(/[\\/]/u).at(-1) ?? "";
  const clean = base.replace(UNSAFE_NAME_CHARACTERS, "_").replace(/^\.+/u, "");
  return clean.trim().slice(0, 120) || "attachment";
}

function blobFile({ bb }: TasksContext, blobPath: string): string {
  const root = resolve(bb.dataDir);
  const file = resolve(root, blobPath);
  if (!file.startsWith(`${root}${sep}`)) {
    throw new Error("Attachment blob path escapes the plugin data directory");
  }
  return file;
}

function ownerTaskId(
  { store }: TasksContext,
  owner: AttachmentOwner,
): string | undefined {
  if (owner.taskId !== null) return store.getTask(owner.taskId)?.id;
  return store.getComment(owner.commentId ?? "")?.taskId;
}

export async function saveAttachment(
  ctx: TasksContext,
  owner: AttachmentOwner,
  requestedName: string,
  bytes: Uint8Array,
  requestedMime?: string,
): Promise<StoredAttachment> {
  const { store } = ctx;
  if (bytes.byteLength > MAX_ATTACHMENT_SIZE_BYTES) {
    throw new AttachmentError(413, "attachment exceeds the 25 MB limit");
  }
  const taskId = ownerTaskId(ctx, owner);
  if ((owner.taskId === null) === (owner.commentId === null) || !taskId) {
    throw new AttachmentError(
      400,
      "an existing taskId or commentId is required",
    );
  }
  const fileName = safeFileName(requestedName);
  const extension = fileName.split(".").at(-1)?.toLowerCase() ?? "";
  const mime = (
    requestedMime?.split(";", 1)[0] ??
    RASTER_MIME_BY_EXTENSION[extension] ??
    "application/octet-stream"
  )
    .trim()
    .toLowerCase();
  if (!MIME_PATTERN.test(mime)) {
    throw new AttachmentError(400, "mime must be a valid MIME type");
  }
  const created = store.createAttachment({
    ...owner,
    fileName,
    mime,
    sizeBytes: bytes.byteLength,
    blobPath: join("blobs", "pending", fileName),
    isImage: INLINE_MIMES.has(mime),
  });
  const blobPath = join("blobs", created.id, fileName);
  const file = blobFile(ctx, blobPath);
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
  } catch (error) {
    store.deleteAttachment(created.id);
    await rm(dirname(file), { recursive: true, force: true });
    throw error;
  }
  store.setBlobPath(created.id, blobPath);
  publish(ctx, "tasks");
  return { ...created, blobPath };
}

export async function readAttachment(
  ctx: TasksContext,
  attachmentId: string,
): Promise<{ attachment: StoredAttachment; content: Buffer } | null> {
  const attachment = ctx.store.getAttachment(attachmentId);
  if (!attachment) return null;
  const file = blobFile(ctx, attachment.blobPath);
  const content = await readFile(file).catch(() => null);
  return content && { attachment, content };
}

export async function deleteAttachment(
  ctx: TasksContext,
  attachmentId: string,
): Promise<boolean> {
  const { store } = ctx;
  const attachment = store.getAttachment(attachmentId);
  if (!attachment) return false;
  const taskId = ownerTaskId(ctx, attachment);
  const task = taskId ? store.getTask(taskId) : undefined;
  const url = attachmentDownloadUrl(attachmentId);
  const file = blobFile(ctx, attachment.blobPath);
  await rm(dirname(file), { recursive: true, force: true });
  if (task?.description.includes(url)) {
    const description = task.description
      .split(/(!\[[^\]]*\]\([^)]*\))/u)
      .filter((part) => !(part.startsWith("![") && part.includes(url)))
      .join("");
    store.updateTask(task.id, { description });
  }
  store.deleteAttachment(attachmentId);
  if (task) publish(ctx, "tasks");
  return true;
}

function failure(error: unknown): Response {
  if (!(error instanceof AttachmentError)) throw error;
  return Response.json({ error: error.message }, { status: error.status });
}

export function registerAttachments(ctx: TasksContext): void {
  const { bb } = ctx;
  const notFound = () =>
    Response.json({ error: "attachment not found" }, { status: 404 });
  const requestedId = (request: Request): string =>
    new URL(request.url).searchParams.get("attachmentId")?.trim() ?? "";

  bb.http.route(
    "POST",
    "/attachments/upload",
    async (request) => {
      const { searchParams } = new URL(request.url);
      const value = (name: string, header: string): string | null =>
        (searchParams.get(name) ?? request.headers.get(header))?.trim() || null;
      const owner = {
        taskId: value("taskId", "x-task-id"),
        commentId: value("commentId", "x-comment-id"),
      };
      const mime =
        value("mime", "x-mime-type") ?? value("mime", "content-type");
      try {
        const fileName = value("fileName", "x-file-name");
        if (fileName === null)
          throw new AttachmentError(400, "fileName is required");
        if (
          Number(request.headers.get("content-length")) >
          MAX_ATTACHMENT_SIZE_BYTES
        ) {
          throw new AttachmentError(413, "attachment exceeds the 25 MB limit");
        }
        const bytes = new Uint8Array(await request.arrayBuffer());
        const saved = await saveAttachment(
          ctx,
          owner,
          fileName,
          bytes,
          mime ?? "",
        );
        const url = attachmentDownloadUrl(saved.id);
        return Response.json({ attachmentId: saved.id, url }, { status: 201 });
      } catch (error) {
        return failure(error);
      }
    },
    { auth: "token" },
  );

  bb.http.route("GET", "/attachments/download", async (request) => {
    const found = await readAttachment(ctx, requestedId(request));
    if (found === null) return notFound();
    const { mime, fileName, isImage } = found.attachment;
    const encoded = encodeURIComponent(fileName).replace(
      /['()*]/gu,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return new Response(new Uint8Array(found.content), {
      headers: {
        "Content-Type": mime,
        "Content-Length": String(found.content.byteLength),
        "Content-Disposition": `${isImage ? "inline" : "attachment"}; filename*=UTF-8''${encoded}`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  bb.http.route("DELETE", "/attachments/delete", async (request) => {
    const deleted = await deleteAttachment(ctx, requestedId(request));
    return deleted ? Response.json({ deleted: true }) : notFound();
  });
}
