import BbDiff from "./BbDiff";
import type { ParsedGitDiffFile } from "@/components/git-diff/git-diff-parsing";
import {
  DEFAULT_CODE_OVERFLOW,
  DEFAULT_DIFF_VIEW,
  type DiffPresentation,
  type ExperimentalDiffFullFileContents,
} from "./code-rendering";

interface DiffHostProps extends Partial<DiffPresentation> {
  file: ParsedGitDiffFile;
  patchText?: string;
  fullFileContents: ExperimentalDiffFullFileContents | null;
  className?: string;
  onSelectionAddToChat?: (text: string) => void;
}

export function DiffHost({
  file,
  patchText,
  fullFileContents,
  view = DEFAULT_DIFF_VIEW,
  overflow = DEFAULT_CODE_OVERFLOW,
  showLineNumbers = true,
  className,
  onSelectionAddToChat,
}: DiffHostProps) {
  return (
    <BbDiff
      file={file}
      patchText={patchText}
      fullFileContents={fullFileContents}
      view={view}
      overflow={overflow}
      showLineNumbers={showLineNumbers}
      className={className}
      onSelectionAddToChat={onSelectionAddToChat}
    />
  );
}
