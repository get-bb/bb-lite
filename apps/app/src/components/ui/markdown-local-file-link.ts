import {
  isAbsoluteFilePathWithinRoot,
  normalizeAbsoluteFilePath,
} from "@/lib/absolute-file-path";
import {
  createFilePreviewLineRange,
  type FilePreviewLineRange,
} from "@bb/client-core";

export interface MarkdownPreviewLocalFileLink {
  lineRange: FilePreviewLineRange | null;
  path: string;
}

export type MarkdownPreviewLocalFileLinkHandler = (
  link: MarkdownPreviewLocalFileLink,
) => boolean;

export type MarkdownAbsoluteLocalFileLinkRouting =
  | { kind: "trusted-host" }
  | { kind: "contained"; rootPath: string };

export interface MarkdownRelativeLocalFileLinkRouting {
  baseDir: string;
  rootPath: string;
}

const LINE_SUFFIX_PATTERN =
  /(?:#L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?|:(\d+)(?:-(\d+)|:\d+)?)$/u;
const URI_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/u;
const UNSAFE_PATH_PATTERN = /[?#\u0000-\u001f]/u;

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function splitLineSuffix(value: string): MarkdownPreviewLocalFileLink {
  const match = LINE_SUFFIX_PATTERN.exec(value);
  if (match === null) {
    const hashIndex = value.indexOf("#");
    return {
      lineRange: null,
      path: hashIndex === -1 ? value : value.slice(0, hashIndex),
    };
  }
  const startLineNumber = Number(match[1] ?? match[3]);
  const endLineNumber = Number(match[2] ?? match[4] ?? startLineNumber);
  return {
    lineRange: createFilePreviewLineRange({ endLineNumber, startLineNumber }),
    path: value.slice(0, match.index),
  };
}

function parseAbsoluteLocalFileHref(
  href: string,
  requireFileBasename: boolean,
): MarkdownPreviewLocalFileLink | null {
  if (href.trim() !== href || !href.startsWith("/") || href.startsWith("//")) {
    return null;
  }
  const parsed = splitLineSuffix(safeDecodeURIComponent(href));
  if (
    parsed.path === "/" ||
    parsed.path.endsWith("/") ||
    UNSAFE_PATH_PATTERN.test(parsed.path) ||
    (requireFileBasename &&
      !parsed.path.slice(parsed.path.lastIndexOf("/") + 1).includes("."))
  ) {
    return null;
  }
  return parsed;
}

export function resolveRelativeLocalFileHref({
  baseDir,
  href,
  rootPath,
}: MarkdownRelativeLocalFileLinkRouting & {
  href: string | undefined;
}): string | null {
  if (!href || href.trim() !== href) {
    return null;
  }
  const decodedHref = safeDecodeURIComponent(href);
  const parsed = splitLineSuffix(decodedHref);
  if (
    parsed.path.length === 0 ||
    /^[/~#?]/u.test(parsed.path) ||
    URI_SCHEME_PATTERN.test(parsed.path)
  ) {
    return null;
  }
  const base = normalizeAbsoluteFilePath({ path: baseDir });
  const root = normalizeAbsoluteFilePath({ path: rootPath });
  const path =
    base === null
      ? null
      : normalizeAbsoluteFilePath({ path: `${base}/${parsed.path}` });
  if (
    base === null ||
    root === null ||
    path === null ||
    !isAbsoluteFilePathWithinRoot({ candidatePath: base, rootPath: root }) ||
    !isAbsoluteFilePathWithinRoot({ candidatePath: path, rootPath: root })
  ) {
    return null;
  }
  return `${path}${decodedHref.slice(parsed.path.length)}`;
}

export function parseLocalFileHref({
  absoluteLinks,
  href,
}: {
  absoluteLinks: MarkdownAbsoluteLocalFileLinkRouting;
  href: string | undefined;
}): MarkdownPreviewLocalFileLink | null {
  if (!href) {
    return null;
  }
  const isFileUrl = href.startsWith("file:///");
  const link = parseAbsoluteLocalFileHref(
    isFileUrl ? href.slice("file://".length) : href,
    absoluteLinks.kind === "trusted-host" && !isFileUrl,
  );
  if (link === null || absoluteLinks.kind === "trusted-host") {
    return link;
  }
  const path = normalizeAbsoluteFilePath({ path: link.path });
  return path !== null &&
    isAbsoluteFilePathWithinRoot({
      candidatePath: path,
      rootPath: absoluteLinks.rootPath,
    })
    ? { ...link, path }
    : null;
}

export function buildLocalFileAnchorHref(
  link: MarkdownPreviewLocalFileLink | null,
  originalHref: string | undefined,
): string | undefined {
  if (!link) {
    return originalHref;
  }
  const { lineRange } = link;
  const fragment =
    lineRange === null
      ? ""
      : lineRange.startLineNumber === lineRange.endLineNumber
        ? `#L${lineRange.startLineNumber}`
        : `#L${lineRange.startLineNumber}-L${lineRange.endLineNumber}`;
  return `file://${link.path.split("/").map(encodeURIComponent).join("/")}${fragment}`;
}
