import path from "node:path";
import { fail, files, type PluginServerApi } from "@bb/plugin";
import { inlineVis } from "./contract.js";

export const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;

const KINDS = new Map<string, "html" | "markdown">([
  [".html", "html"],
  [".htm", "html"],
  [".md", "markdown"],
  [".markdown", "markdown"],
]);

const invalid: (message: string) => never = (message) =>
  fail("invalid", message);

function previewKind(file: string): "html" | "markdown" {
  const kind = KINDS.get(path.posix.extname(file).toLowerCase());
  if (kind === undefined) {
    invalid(
      `"file" must end with .html, .htm, .md, or .markdown, got ${JSON.stringify(file)}`,
    );
  }
  return kind;
}

export function relativePreviewFile(value: string): string {
  const file = value.trim();
  if (file.length === 0) invalid(`"file" must be a non-empty string`);
  if (
    path.isAbsolute(file) ||
    /^[a-zA-Z]:[\\/]/.test(file) ||
    file.startsWith("\\\\")
  ) {
    invalid(`"file" must be source-relative, not absolute: ${file}`);
  }
  const slashed = file.replace(/\\/g, "/");
  if (slashed.split("/").includes("..")) {
    invalid(`"file" must not contain traversal segments: ${file}`);
  }
  const normalized = path.posix.normalize(slashed);
  if (normalized === "." || normalized.startsWith("/")) {
    invalid(`"file" must not escape its source: ${file}`);
  }
  previewKind(normalized);
  return normalized;
}

export default function inlineVisServer(bb: PluginServerApi): void {
  bb.implement(inlineVis.preview, async ({ threadId, file: raw, source }) => {
    const file = relativePreviewFile(raw);
    const target = { threadId, path: file, source };
    const { url } = await bb.call(files.url, target);
    const read = await bb.call(files.read, target);
    if (read === null) return { kind: "not-found" as const, file };
    const sizeBytes = Buffer.byteLength(read.content);
    if (sizeBytes > MAX_PREVIEW_BYTES) {
      invalid(
        `Preview file is too large (${sizeBytes} bytes; max ${MAX_PREVIEW_BYTES}).`,
      );
    }
    const kind = previewKind(file);
    return kind === "html"
      ? { kind, file, source, url }
      : { kind, file, source, url, content: read.content };
  });
}
