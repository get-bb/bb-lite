import { useState } from "react";
import type { TimelineConversationAttachments } from "@bb/server-contract";
import type { PromptDraftAttachment } from "@bb/client-core";
import { fileNameFromPath } from "@bb/thread-view";
import {
  ImageLightbox,
  getWrappedImageIndex,
} from "@bb/app-kit/components/ui/image-lightbox";
import { cn } from "@bb/shared-ui/lib/utils";
import { buildProjectAttachmentContentUrl } from "@bb/app-kit/lib/file-content-urls";
import { toUserAttachmentImageSrc } from "@bb/app-kit/lib/user-attachment-images";
import { useTimeline } from "./timeline-context";

export interface ConversationAttachmentItems {
  draftAttachments: PromptDraftAttachment[];
  filePaths: string[];
  imageItems: { alt: string; src: string }[];
}

const ABSOLUTE_LOCAL_PATH_PATTERN = /^(?:\/|[a-zA-Z]:[\\/])/u;
const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/u;

export function buildAttachmentItems(
  attachments: TimelineConversationAttachments | null,
  projectId: string | undefined,
): ConversationAttachmentItems {
  if (!attachments) {
    return { draftAttachments: [], filePaths: [], imageItems: [] };
  }
  const draft = (type: "localImage" | "localFile") => (path: string) => ({
    type,
    path,
    name: fileNameFromPath(path),
    sizeBytes: 0,
  });
  return {
    draftAttachments: [
      ...attachments.localImagePaths.map(draft("localImage")),
      ...attachments.localFilePaths.map(draft("localFile")),
    ],
    filePaths: attachments.localFilePaths,
    imageItems: [
      ...attachments.imageUrls.map((url) => ({
        alt: fileNameFromPath(url),
        src: url,
      })),
      ...attachments.localImagePaths.map((path) => ({
        alt: fileNameFromPath(path),
        src: toUserAttachmentImageSrc(path, projectId),
      })),
    ],
  };
}

export function ConversationAttachments({
  align = "start",
  filePaths,
  imageItems,
}: Pick<ConversationAttachmentItems, "filePaths" | "imageItems"> & {
  align?: "start" | "end";
}) {
  const { onOpenLocalFileLink, projectId } = useTimeline();
  const [expandedImageIndex, setExpandedImageIndex] = useState<number | null>(
    null,
  );
  const currentImageItem =
    expandedImageIndex === null
      ? null
      : (imageItems[expandedImageIndex] ?? null);
  const justifyClassName = align === "end" ? "justify-end" : "justify-start";
  const surfaceClassName =
    align === "end"
      ? "border-surface-selected-border bg-surface-raised"
      : "border-border bg-surface-recessed";
  const stepImage = (direction: "previous" | "next") => {
    setExpandedImageIndex(
      expandedImageIndex === null || imageItems.length <= 1
        ? expandedImageIndex
        : getWrappedImageIndex({
            currentIndex: expandedImageIndex,
            direction,
            itemCount: imageItems.length,
          }),
    );
  };

  if (filePaths.length === 0 && imageItems.length === 0) {
    return null;
  }

  return (
    <div className="mt-2 space-y-2">
      {imageItems.length > 0 ? (
        <div className={cn("flex flex-wrap gap-2", justifyClassName)}>
          {imageItems.map((imageItem, index) => (
            <button
              type="button"
              key={`${imageItem.src}-${index}`}
              className={cn(
                "cursor-zoom-in overflow-hidden rounded-md border",
                surfaceClassName,
              )}
              onClick={() => setExpandedImageIndex(index)}
              title={imageItem.alt}
            >
              <img
                src={imageItem.src}
                alt={imageItem.alt}
                className={cn(
                  "object-cover",
                  align === "end" ? "h-20 max-w-36" : "h-16 w-24",
                )}
                loading="lazy"
                decoding="async"
              />
            </button>
          ))}
        </div>
      ) : null}
      {filePaths.length > 0 ? (
        <div className={cn("flex flex-wrap gap-1.5", justifyClassName)}>
          {filePaths.map((path) => {
            const className = cn(
              "inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-xs text-muted-foreground",
              surfaceClassName,
            );
            const label = (
              <span className="truncate">{fileNameFromPath(path)}</span>
            );
            const isAbsolute = ABSOLUTE_LOCAL_PATH_PATTERN.test(path);
            if (
              projectId &&
              path.length > 0 &&
              !path.startsWith("\\") &&
              !isAbsolute &&
              !URL_SCHEME_PATTERN.test(path)
            ) {
              return (
                <a
                  key={path}
                  href={buildProjectAttachmentContentUrl(projectId, path)}
                  target="_blank"
                  rel="noreferrer"
                  className={cn(
                    className,
                    "cursor-pointer hover:bg-state-hover",
                  )}
                >
                  {label}
                </a>
              );
            }
            if (!onOpenLocalFileLink || !isAbsolute) {
              return (
                <span key={path} className={cn(className, "cursor-default")}>
                  {label}
                </span>
              );
            }
            return (
              <button
                key={path}
                type="button"
                className={cn(className, "cursor-pointer hover:bg-state-hover")}
                onClick={() => {
                  onOpenLocalFileLink({ lineRange: null, path });
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      ) : null}
      <ImageLightbox
        title="Attached image preview"
        imageSrc={currentImageItem?.src ?? null}
        imageAlt={currentImageItem?.alt ?? "Attached image"}
        hasMultipleImages={imageItems.length > 1}
        onPrevious={() => stepImage("previous")}
        onNext={() => stepImage("next")}
        onClose={() => setExpandedImageIndex(null)}
      />
    </div>
  );
}
