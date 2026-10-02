const MAX_LOCAL_PREVIEWS = 24;

const localPreviewUrlsByPath = new Map<string, string>();

export function registerLocalAttachmentPreview(path: string, file: Blob): void {
  if (!file.type.startsWith("image/")) return;
  releaseLocalAttachmentPreview(path);
  localPreviewUrlsByPath.set(path, URL.createObjectURL(file));
  for (const oldest of localPreviewUrlsByPath.keys()) {
    if (localPreviewUrlsByPath.size <= MAX_LOCAL_PREVIEWS) break;
    releaseLocalAttachmentPreview(oldest);
  }
}

export function getLocalAttachmentPreviewSrc(path: string): string | null {
  return localPreviewUrlsByPath.get(path) ?? null;
}

export function releaseLocalAttachmentPreview(path: string): void {
  const url = localPreviewUrlsByPath.get(path);
  if (url === undefined) return;
  localPreviewUrlsByPath.delete(path);
  URL.revokeObjectURL(url);
}
