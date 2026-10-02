import { useMemo, type CSSProperties } from "react";
import type { FileDiffOptions } from "@pierre/diffs";
import { FileDiff as DiffView } from "@pierre/diffs/react";
import { usePierreStrictModeRecoveryOptions } from "@/lib/pierre-strict-mode-recovery";
import { enrichGitDiffFileForContext } from "@/components/git-diff/git-diff-parsing";
import { useCodeHighlighter } from "@/lib/code-theme-registration";
import { DiffLoadingSkeleton } from "./code-loading-skeletons";
import { usePreferredTheme } from "@/hooks/useTheme";
import type { BbDiffProps } from "./code-rendering";

const DIFF_VIEW_STYLE = {
  "--diffs-font-size": "12px",
  "--diffs-line-height": "18px",
} as CSSProperties;

function BbDiff({
  file,
  patchText,
  fullFileContents,
  view,
  overflow,
  showLineNumbers,
}: BbDiffProps) {
  const resolvedFile = useMemo(
    () =>
      fullFileContents === null
        ? file
        : enrichGitDiffFileForContext({
            fileDiff: file,
            oldFile: {
              name: fullFileContents.old.path,
              contents: fullFileContents.old.content,
            },
            newFile: {
              name: fullFileContents.new.path,
              contents: fullFileContents.new.content,
            },
            patchText,
          }),
    [file, fullFileContents, patchText],
  );
  const canExpand = resolvedFile !== file && resolvedFile.isPartial === false;
  const { theme: codeTheme, isReady } = useCodeHighlighter(file.name);
  const themeType = usePreferredTheme();
  const baseOptions = useMemo<FileDiffOptions<undefined>>(
    () => ({
      diffStyle: view,
      overflow,
      disableLineNumbers: !showLineNumbers,
      disableFileHeader: true,
      ...(canExpand ? { expansionLineCount: 30 } : {}),
      themeType,
      theme: codeTheme,
      enableGutterUtility: false,
      enableLineSelection: false,
      lineHoverHighlight: "disabled",
    }),
    [canExpand, codeTheme, overflow, showLineNumbers, themeType, view],
  );
  const options = usePierreStrictModeRecoveryOptions(baseOptions);
  if (!isReady) return <DiffLoadingSkeleton />;
  return (
    <div className="overflow-x-auto">
      <div className="w-full max-w-full" style={DIFF_VIEW_STYLE}>
        <DiffView fileDiff={resolvedFile} options={options} />
      </div>
    </div>
  );
}

export default BbDiff;
