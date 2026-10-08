import { useState } from "react";
import { ImageLightbox } from "@bb/plugin/app";
import {
  attachmentDownloadUrl,
  type Attachment,
} from "../../shared/contract.js";
import { reportError } from "../../shell/data.js";
import { ConfirmDialog } from "../../components/common.js";
import { Icon } from "@bb/shared-ui/icon";

const PLUGIN_URL = "/api/v1/plugins/tasks";
let tokenPromise: Promise<string> | null = null;

async function fetchPluginToken(): Promise<string> {
  const headers = { "content-type": "application/json" };
  const init = { method: "POST", headers, body: "{}" };
  const response = await fetch(`${PLUGIN_URL}/token`, init);
  const body: unknown = await response.json().catch(() => null);
  const token: unknown = body && Reflect.get(body, "token");
  if (response.ok && typeof token === "string") return token;
  throw new Error(`failed to fetch plugin token (HTTP ${response.status})`);
}

export async function uploadAttachment(
  file: File,
  taskId: string,
): Promise<{ url: string }> {
  tokenPromise ??= fetchPluginToken();
  const token = await tokenPromise.catch((error: unknown) => {
    tokenPromise = null;
    throw error;
  });
  const query = new URLSearchParams({
    taskId,
    fileName: file.name || "attachment",
    mime: file.type || "application/octet-stream",
  });
  const response = await fetch(
    `${PLUGIN_URL}/http/attachments/upload?${query.toString()}`,
    { method: "POST", headers: { "x-bb-plugin-token": token }, body: file },
  );
  const body: unknown = await response.json().catch(() => null);
  const field = (name: string): unknown => body && Reflect.get(body, name);
  if (response.ok) return { url: String(field("url")) };
  const reason = field("error") ?? field("message");
  throw new Error(String(reason ?? `upload failed (${response.status})`));
}

function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  const kb = sizeBytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function AttachmentsGrid({
  attachments,
  onRemove,
}: {
  attachments: Attachment[];
  onRemove?: (attachment: Attachment) => Promise<unknown>;
}) {
  const [lightbox, setLightbox] = useState<Attachment | null>(null);
  const [confirm, setConfirm] = useState<Attachment | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  const performRemove = async (attachment: Attachment) => {
    setPending((current) => new Set(current).add(attachment.id));
    await onRemove?.(attachment).catch(reportError);
    setPending(
      (current) => new Set([...current].filter((id) => id !== attachment.id)),
    );
  };

  if (attachments.length === 0) return null;
  const files = attachments.filter((attachment) => !attachment.isImage);
  const images = attachments.filter((attachment) => attachment.isImage);

  const removeButton = (attachment: Attachment, className: string) => {
    const busy = pending.has(attachment.id);
    return onRemove ? (
      <button
        type="button"
        aria-label={`Remove ${attachment.fileName}`}
        disabled={busy}
        className={className}
        onClick={() => setConfirm(attachment)}
      >
        {busy ? (
          <span
            role="status"
            aria-label="Removing"
            className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
        ) : (
          <Icon name="X" className="size-3" />
        )}
      </button>
    ) : null;
  };

  return (
    <div className="flex flex-col gap-2">
      {files.length > 0 ? (
        <div className="flex flex-wrap items-start gap-2">
          {files.map((attachment) => (
            <div
              key={attachment.id}
              className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-sm shadow-2xs"
            >
              <a
                href={attachmentDownloadUrl(attachment.id)}
                download={attachment.fileName}
                className="flex min-w-0 items-center gap-2 rounded-sm hover:bg-state-hover"
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-secondary text-muted-foreground">
                  <Icon name="File" className="size-3.5" />
                </span>
                <span className="min-w-0">
                  <span className="block max-w-48 truncate">
                    {attachment.fileName}
                  </span>
                  <span className="block text-2xs text-muted-foreground">
                    {formatFileSize(attachment.sizeBytes)}
                  </span>
                </span>
              </a>
              {removeButton(
                attachment,
                "shrink-0 rounded p-0.5 text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-70",
              )}
            </div>
          ))}
        </div>
      ) : null}
      {images.length > 0 ? (
        <div className="flex flex-wrap items-start gap-2">
          {images.map((attachment) => (
            <div
              key={attachment.id}
              className="group relative overflow-hidden rounded-md border border-border shadow-2xs"
            >
              <button
                type="button"
                className="block"
                title={`${attachment.fileName} · ${formatFileSize(attachment.sizeBytes)}`}
                onClick={() => setLightbox(attachment)}
              >
                <img
                  src={attachmentDownloadUrl(attachment.id)}
                  alt={attachment.fileName}
                  className="block h-24 w-36 object-cover transition-opacity group-hover:opacity-90"
                />
                <span
                  className="absolute inset-x-0 bottom-0 truncate px-1.5 py-0.5 text-left text-2xs opacity-0 transition-opacity group-hover:opacity-100"
                  style={{
                    background:
                      "color-mix(in oklab, var(--ink) 55%, transparent)",
                    color: "var(--canvas)",
                  }}
                >
                  {attachment.fileName}
                </span>
              </button>
              {removeButton(
                attachment,
                "absolute right-1 top-1 z-10 rounded-full bg-black/55 p-0.5 text-white transition-colors hover:bg-black/70 disabled:opacity-70",
              )}
            </div>
          ))}
        </div>
      ) : null}
      <ImageLightbox
        imageSrc={lightbox ? attachmentDownloadUrl(lightbox.id) : null}
        imageAlt={lightbox?.fileName ?? ""}
        title={lightbox?.fileName ?? ""}
        onClose={() => setLightbox(null)}
      />
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title="Remove attachment?"
        description={
          confirm
            ? `"${confirm.fileName}" will be permanently removed. Any references in the task description will be removed too. This cannot be undone.`
            : ""
        }
        confirmLabel="Remove"
        onConfirm={() => {
          if (confirm) void performRemove(confirm);
        }}
      />
    </div>
  );
}
