import type { ParsedGitDiffFile } from "@/components/git-diff/git-diff-parsing";
import type { CodeOverflowMode } from "@/lib/code-overflow-mode";

export interface DiffFullFileContents {
  old: { path: string; content: string };
  new: { path: string; content: string };
}

export interface DiffPresentation {
  view: "unified" | "split";
  overflow: CodeOverflowMode;
  showLineNumbers: boolean;
}

export interface BbSourceCodeProps {
  content: string;
  path: string;
  cacheKey?: string;
  overflow: CodeOverflowMode;
  highlightedLines: { start: number; end: number } | null;
}

export interface BbDiffProps extends DiffPresentation {
  file: ParsedGitDiffFile;
  patchText?: string;
  fullFileContents: DiffFullFileContents | null;
}
