const UTF8_TEXT_MIME_TYPES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/json",
  "application/ld+json",
  "application/sql",
  "application/toml",
  "application/typescript",
  "application/x-httpd-php",
  "application/x-sh",
  "application/x-typescript",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
]);
const NULL_CHARACTER = "\u0000";

export const FILE_PREVIEW_SAMPLE_BYTES = 64 * 1024;
const FILE_PREVIEW_TEXT_MAX_BYTES = 25 * 1024 * 1024;

export interface FilePreviewTarget {
  name?: string;
  path: string;
  url: string;
}

type FilePreviewBase = FilePreviewTarget & { mimeType: string };

export type FilePreview =
  | (FilePreviewBase & { kind: "image" | "video" })
  | (FilePreviewBase & { kind: "text"; content: string })
  | (FilePreviewBase & {
      kind: "unsupported";
      reason: "binary" | "too-large";
      sizeBytes: number;
    });

export type EnvironmentFilePreviewSource =
  | { kind: "working-tree" }
  | { kind: "head" }
  | { kind: "merge-base"; ref: string };

export type WorkspaceFilePreviewStatusLabel = "deleted";

export interface FilePreviewLineRange {
  endLineNumber: number;
  startLineNumber: number;
}

export interface HostFileTabState {
  lineRange: FilePreviewLineRange | null;
  path: string;
}

export interface WorkspaceFileTabState extends HostFileTabState {
  source: EnvironmentFilePreviewSource;
  statusLabel: WorkspaceFilePreviewStatusLabel | null;
}

export function createFilePreviewLineRange({
  endLineNumber,
  startLineNumber,
}: FilePreviewLineRange): FilePreviewLineRange | null {
  return Number.isSafeInteger(startLineNumber) &&
    Number.isSafeInteger(endLineNumber) &&
    startLineNumber > 0 &&
    endLineNumber >= startLineNumber
    ? { endLineNumber, startLineNumber }
    : null;
}

export function getFilePreviewLineRangeStart(args: {
  lineRange: FilePreviewLineRange | null;
}): number | null {
  return args.lineRange?.startLineNumber ?? null;
}

function isKnownTextMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType.endsWith("+json") ||
    mimeType.endsWith("+xml") ||
    UTF8_TEXT_MIME_TYPES.has(mimeType)
  );
}

function decodeText(bytes: Uint8Array, mimeType: string): string | null {
  try {
    const content = new TextDecoder("utf-8", {
      fatal: !isKnownTextMimeType(mimeType),
    }).decode(bytes);
    return content.includes(NULL_CHARACTER) ? null : content;
  } catch {
    return null;
  }
}

export function normalizeFilePreviewMimeType(value: string | null): string {
  return (
    value?.split(";")[0]?.trim().toLowerCase() || "application/octet-stream"
  );
}

export function isMarkdownFilePreview(preview: FilePreview): boolean {
  const isMarkdownPath = (path: string | undefined) =>
    /\.(md|markdown)$/iu.test(path ?? "");
  return (
    preview.kind === "text" &&
    (preview.mimeType === "text/markdown" ||
      preview.mimeType === "text/x-markdown" ||
      isMarkdownPath(preview.path) ||
      isMarkdownPath(preview.name))
  );
}

export function buildFilePreview(
  args: FilePreviewBase & { contentBytes: Uint8Array },
): FilePreview {
  const { contentBytes, ...base } = args;
  if (base.mimeType.startsWith("image/")) return { kind: "image", ...base };
  const content = decodeText(contentBytes, base.mimeType);
  if (content !== null) return { kind: "text", ...base, content };
  if (
    !isKnownTextMimeType(base.mimeType) &&
    base.mimeType.startsWith("video/")
  ) {
    return { kind: "video", ...base };
  }
  const sizeBytes = contentBytes.byteLength;
  return { kind: "unsupported", ...base, reason: "binary", sizeBytes };
}

export function buildFilePreviewFromSample(
  args: FilePreviewBase & { sampleBytes: Uint8Array; sizeBytes: number },
): FilePreview | null {
  const { sampleBytes, sizeBytes, ...base } = args;
  if (base.mimeType.startsWith("image/")) return { kind: "image", ...base };
  let isText: boolean;
  try {
    isText = !new TextDecoder("utf-8", {
      fatal: !isKnownTextMimeType(base.mimeType),
    })
      .decode(sampleBytes, { stream: true })
      .includes(NULL_CHARACTER);
  } catch {
    isText = false;
  }
  if (isText) {
    return sizeBytes > FILE_PREVIEW_TEXT_MAX_BYTES
      ? { kind: "unsupported", ...base, reason: "too-large", sizeBytes }
      : null;
  }
  return base.mimeType.startsWith("video/")
    ? { kind: "video", ...base }
    : { kind: "unsupported", ...base, reason: "binary", sizeBytes };
}
