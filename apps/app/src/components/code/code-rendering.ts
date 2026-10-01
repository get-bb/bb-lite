import type { ParsedGitDiffFile } from "@/components/git-diff/git-diff-parsing";
import type { CodeOverflowMode } from "@/lib/code-overflow-mode";

type DiffViewMode = "unified" | "split";

interface SourceCodeLineRange {
  start: number;
  end: number;
}

interface ExperimentalDiffFileContent {
  path: string;
  content: string;
}

export interface ExperimentalDiffFullFileContents {
  old: ExperimentalDiffFileContent;
  new: ExperimentalDiffFileContent;
}

export const DEFAULT_CODE_OVERFLOW: CodeOverflowMode = "scroll";
export const DEFAULT_DIFF_VIEW: DiffViewMode = "unified";

interface SourceCodePresentation {
  overflow: CodeOverflowMode;
  highlightedLines: SourceCodeLineRange | null;
}

export interface DiffPresentation {
  view: DiffViewMode;
  overflow: CodeOverflowMode;
  showLineNumbers: boolean;
}

export interface BbSourceCodeProps extends SourceCodePresentation {
  content: string;
  path: string;
  cacheKey?: string;
  className?: string;
  scrollToHighlightedLines?: boolean;
  onSelectionAddToChat?: (text: string) => void;
}

export interface BbDiffProps extends DiffPresentation {
  file: ParsedGitDiffFile;
  patchText?: string;
  fullFileContents: ExperimentalDiffFullFileContents | null;
  className?: string;
  onSelectionAddToChat?: (text: string) => void;
}
