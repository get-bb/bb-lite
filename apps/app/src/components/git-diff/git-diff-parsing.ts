import { parsePatchFiles, processFile, type FileContents } from "@pierre/diffs";
import type { GitDiffFileChangeKind } from "@bb/server-contract";

export type ParsedGitDiffFile = ReturnType<
  typeof parsePatchFiles
>[number]["files"][number];

export interface GitDiffStats {
  filesCount: number;
  insertions: number;
  deletions: number;
}

export function parseGitDiffFiles(diff: string): ParsedGitDiffFile[] {
  if (diff.trim().length === 0) return [];
  try {
    return parsePatchFiles(diff).flatMap((patch) => patch.files);
  } catch {
    return [];
  }
}

interface GitDiffContextEnrichmentInput {
  fileDiff: ParsedGitDiffFile;
  oldFile: FileContents;
  newFile: FileContents;
  patchText?: string;
}

export function enrichGitDiffFileForContext({
  fileDiff,
  oldFile,
  newFile,
  patchText,
}: GitDiffContextEnrichmentInput): ParsedGitDiffFile {
  const newPath = normalizeGitDiffPath(fileDiff.name);
  const oldPath = normalizeGitDiffPath(fileDiff.prevName) ?? newPath;
  if (
    !patchText ||
    newPath === undefined ||
    normalizeGitDiffPath(oldFile.name) !== oldPath ||
    normalizeGitDiffPath(newFile.name) !== newPath
  ) {
    return fileDiff;
  }
  const enriched = processFile(patchText, { oldFile, newFile });
  const hunksMatch =
    enriched !== undefined &&
    !enriched.isPartial &&
    fileDiff.hunks.every(
      (hunk) =>
        doLineRangesMatch(
          fileDiff.deletionLines,
          hunk.deletionLineIndex,
          enriched.deletionLines,
          hunk.deletionStart - 1,
          hunk.deletionCount,
        ) &&
        doLineRangesMatch(
          fileDiff.additionLines,
          hunk.additionLineIndex,
          enriched.additionLines,
          hunk.additionStart - 1,
          hunk.additionCount,
        ),
    );
  return hunksMatch ? enriched : fileDiff;
}

function doLineRangesMatch(
  expectedLines: string[],
  expectedStart: number,
  actualLines: string[],
  actualStart: number,
  count: number,
): boolean {
  if (
    expectedStart < 0 ||
    actualStart < 0 ||
    count < 0 ||
    expectedStart + count > expectedLines.length ||
    actualStart + count > actualLines.length
  ) {
    return false;
  }
  const comparable = (line: string | undefined) =>
    line?.endsWith("\r\n") ? `${line.slice(0, -2)}\n` : (line ?? "");
  for (let index = 0; index < count; index += 1) {
    if (
      comparable(expectedLines[expectedStart + index]) !==
      comparable(actualLines[actualStart + index])
    ) {
      return false;
    }
  }
  return true;
}

export function summarizeGitDiffFile(
  file: ParsedGitDiffFile,
): Pick<GitDiffStats, "insertions" | "deletions"> {
  let insertions = 0;
  let deletions = 0;
  for (const hunk of file.hunks) {
    insertions += hunk.additionLines;
    deletions += hunk.deletionLines;
  }
  return { insertions, deletions };
}

export function getGitDiffFileChangeKind(
  file: ParsedGitDiffFile,
): GitDiffFileChangeKind {
  switch (file.type) {
    case "new":
      return "added";
    case "deleted":
      return "deleted";
    case "rename-pure":
    case "rename-changed":
      return "renamed";
    case "change":
      return "modified";
  }
}

export function formatGitDiffFileLabel(file: ParsedGitDiffFile): string {
  const name = normalizeGitDiffPath(file.name) ?? file.name;
  const prevName = normalizeGitDiffPath(file.prevName);
  return prevName && prevName !== name ? `${prevName} -> ${name}` : name;
}

export function normalizeGitDiffPath(
  path: string | undefined,
): string | undefined {
  return path?.trim() || undefined;
}

export function getOpenableGitDiffPath(file: ParsedGitDiffFile): string | null {
  for (const candidate of [file.name, file.prevName]) {
    const path = normalizeGitDiffPath(candidate)?.replace(/^\.\//, "");
    if (!path || path === "/dev/null") continue;
    return path.startsWith("a/") || path.startsWith("b/")
      ? path.slice(2)
      : path;
  }
  return null;
}
