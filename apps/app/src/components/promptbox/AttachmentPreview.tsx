import { useEffect, useState } from "react";
import type { PendingAttachmentUpload } from "./useDraftAttachmentUploads";
import {
  getWrappedImageIndex,
  ImageLightbox,
} from "@/components/ui/image-lightbox.js";
import { Icon } from "@bb/shared-ui/icon";
import type { PromptDraftAttachment } from "@bb/client-core";
import { toUserAttachmentImageSrc } from "@/lib/user-attachment-images";
import {
  getLocalAttachmentPreviewSrc,
  releaseLocalAttachmentPreview,
} from "@/lib/attachment-local-previews";

function isImageAttachment(attachment: PromptDraftAttachment): boolean {
  return (
    attachment.type === "localImage" ||
    attachment.mimeType?.toLowerCase().startsWith("image/") === true
  );
}

function UploadPreview({ file }: { file: File }) {
  const [previewUrl, setPreviewUrl] = useState<string>();
  const isImage = file.type.startsWith("image/");
  useEffect(() => {
    if (!isImage) return;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file, isImage]);

  return (
    <div
      role="status"
      aria-label={`Uploading ${file.name}`}
      className={
        isImage
          ? "relative shrink-0 overflow-hidden rounded-md border border-border bg-surface-recessed"
          : "inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-surface-recessed px-2 py-0.5 text-xs text-muted-foreground"
      }
    >
      {isImage ? (
        <>
          <span className="block h-16 w-24">
            {previewUrl ? (
              <img
                src={previewUrl}
                alt=""
                className="size-full object-cover opacity-50"
              />
            ) : null}
          </span>
          <span className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-background/90 py-1 text-xs text-foreground">
            <Icon
              name="Loading"
              className="size-3 animate-spin motion-reduce:animate-none"
            />
            Uploading
          </span>
        </>
      ) : (
        <>
          <Icon
            name="Loading"
            className="size-3 shrink-0 animate-spin motion-reduce:animate-none"
          />
          <span className="truncate">{file.name}</span>
        </>
      )}
    </div>
  );
}

export function AttachmentPreview({
  attachments,
  pendingUploads = [],
  attachmentProjectId,
  onRemoveAttachment,
}: {
  attachments: PromptDraftAttachment[];
  pendingUploads?: readonly PendingAttachmentUpload[];
  attachmentProjectId?: string;
  onRemoveAttachment?: (path: string) => void;
}) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const images = attachments.filter(isImageAttachment).map((attachment) => ({
    attachment,
    src:
      getLocalAttachmentPreviewSrc(attachment.path) ??
      toUserAttachmentImageSrc(attachment.path, attachmentProjectId),
  }));
  const files = attachments.filter(
    (attachment) => !isImageAttachment(attachment),
  );
  const expanded = expandedIndex === null ? undefined : images[expandedIndex];
  const step = (direction: "previous" | "next") => {
    if (expandedIndex !== null && images.length > 1) {
      setExpandedIndex(
        getWrappedImageIndex({
          currentIndex: expandedIndex,
          direction,
          itemCount: images.length,
        }),
      );
    }
  };

  if (attachments.length + pendingUploads.length === 0) {
    return null;
  }

  return (
    <>
      <div className="mx-3 mb-1 mt-1">
        {images.length > 0 || pendingUploads.length > 0 ? (
          <div className="mb-1.5 flex flex-wrap gap-2">
            {images.map(({ attachment, src }, index) => (
              <div key={`${attachment.path}-${index}`} className="relative">
                <button
                  type="button"
                  className="block cursor-zoom-in overflow-hidden rounded-md border border-border bg-surface-recessed"
                  onClick={() => setExpandedIndex(index)}
                  title={attachment.name}
                >
                  <img
                    src={src}
                    alt={attachment.name}
                    className="h-16 w-24 object-cover"
                    loading="lazy"
                    decoding="async"
                  />
                </button>
                {onRemoveAttachment ? (
                  <button
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={(event) => {
                      event.currentTarget.blur();
                      releaseLocalAttachmentPreview(attachment.path);
                      onRemoveAttachment(attachment.path);
                    }}
                    className="group/attachment-remove-image absolute right-1 top-1 z-10 inline-flex size-4 items-center justify-center rounded-full text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    aria-label={`Remove ${attachment.name}`}
                  >
                    <span className="inline-flex size-4 items-center justify-center rounded-full bg-black/55 transition-colors group-hover/attachment-remove-image:bg-black/70">
                      <Icon name="X" className="size-3" />
                    </span>
                  </button>
                ) : null}
              </div>
            ))}
            {pendingUploads.map((upload) => (
              <UploadPreview key={upload.id} file={upload.file} />
            ))}
          </div>
        ) : null}

        {files.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {files.map((attachment) => (
              <span
                key={attachment.path}
                className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-surface-recessed px-2 py-0.5 text-xs text-muted-foreground"
              >
                <span className="truncate">{attachment.name}</span>
                {onRemoveAttachment ? (
                  <span className="relative size-4 shrink-0">
                    <button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={(event) => {
                        event.currentTarget.blur();
                        onRemoveAttachment(attachment.path);
                      }}
                      className="group/attachment-remove-file absolute left-1/2 top-1/2 inline-flex size-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      aria-label={`Remove ${attachment.name}`}
                    >
                      <span className="inline-flex size-4 items-center justify-center rounded transition-colors group-hover/attachment-remove-file:bg-state-hover">
                        <Icon name="X" className="size-3" />
                      </span>
                    </button>
                  </span>
                ) : null}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <ImageLightbox
        imageSrc={expanded?.src ?? null}
        imageAlt={expanded?.attachment.name ?? "Attached image"}
        title="Attached image preview"
        hasMultipleImages={images.length > 1}
        onPrevious={() => step("previous")}
        onNext={() => step("next")}
        onClose={() => setExpandedIndex(null)}
      />
    </>
  );
}
