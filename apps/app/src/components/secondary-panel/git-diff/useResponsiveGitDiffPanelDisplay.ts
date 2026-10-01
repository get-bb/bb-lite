import { useCallback, useState } from "react";
import { useGitDiffDisplayModePreference } from "@/lib/git-diff-view-preferences";
import type {
  GitDiffDisplayMode,
  GitDiffDisplayModeChangeHandler,
} from "../GitDiffToolbar";
import type { SecondaryPanelWidthChangeHandler } from "../useSecondaryPanelResize";

const GIT_DIFF_SPLIT_VIEW_MIN_WIDTH_PX = 760;

interface ResolveGitDiffDisplayModeArgs {
  displayModePreference: GitDiffDisplayMode | null;
  isWideEnoughForSplit: boolean | null;
}

export function resolveGitDiffDisplayMode({
  displayModePreference,
  isWideEnoughForSplit,
}: ResolveGitDiffDisplayModeArgs): GitDiffDisplayMode {
  if (displayModePreference !== null) {
    return displayModePreference;
  }
  return isWideEnoughForSplit === true ? "split" : "unified";
}

interface UseResponsiveGitDiffPanelDisplayArgs {
  isSecondaryPanelOpen: boolean;
}

export function useResponsiveGitDiffPanelDisplay({
  isSecondaryPanelOpen,
}: UseResponsiveGitDiffPanelDisplayArgs) {
  const [displayModePreference, setDisplayModePreference] =
    useGitDiffDisplayModePreference();
  const [isWideEnoughForSplit, setIsWideEnoughForSplit] = useState<
    boolean | null
  >(null);

  const handleSecondaryPanelWidthChange =
    useCallback<SecondaryPanelWidthChangeHandler>(
      (nextWidth) => {
        if (!isSecondaryPanelOpen || nextWidth === undefined) {
          return;
        }

        const nextWideEnough = nextWidth >= GIT_DIFF_SPLIT_VIEW_MIN_WIDTH_PX;
        setIsWideEnoughForSplit((current) =>
          current === nextWideEnough ? current : nextWideEnough,
        );
      },
      [isSecondaryPanelOpen],
    );

  const handleGitDiffDisplayModeChange =
    useCallback<GitDiffDisplayModeChangeHandler>(
      (nextMode) => {
        setDisplayModePreference(nextMode);
      },
      [setDisplayModePreference],
    );

  return {
    gitDiffDisplayMode: resolveGitDiffDisplayMode({
      displayModePreference,
      isWideEnoughForSplit,
    }),
    handleGitDiffDisplayModeChange,
    handleSecondaryPanelWidthChange,
  };
}
