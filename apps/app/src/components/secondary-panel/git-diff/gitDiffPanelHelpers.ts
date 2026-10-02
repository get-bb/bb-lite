import type { WorkspaceCommitSummary, WorkspaceDiffTarget } from "@bb/domain";
import type { DiffFileEntry } from "@bb/server-contract";
import picomatch from "picomatch/posix";
import type { GitDiffSelectionOption } from "../GitDiffToolbar";

export function buildGitDiffIdentity(
  environmentId: string | undefined,
  mergeBaseRef: string | null,
  target: WorkspaceDiffTarget | undefined,
): string {
  const environmentKey = environmentId ?? "none";
  if (!target) return `${environmentKey}:none`;
  switch (target.type) {
    case "uncommitted":
      return `${environmentKey}:uncommitted`;
    case "branch_committed":
    case "all":
      return [
        environmentKey,
        target.type,
        target.mergeBaseBranch,
        mergeBaseRef ?? "pending",
      ].join(":");
    case "commit":
      return `${environmentKey}:commit:${target.sha}`;
  }
}

export const GIT_DIFF_AUTO_COLLAPSE_FILE_THRESHOLD = 10;
export const ALL_GIT_DIFF_SELECTION = "all";
const COMMITTED_GIT_DIFF_SELECTION = "branch_committed";
const UNCOMMITTED_GIT_DIFF_SELECTION = "uncommitted";

export function buildGitDiffTarget(
  selection: string | null,
  mergeBaseBranch: string | undefined,
): WorkspaceDiffTarget | undefined {
  if (selection === UNCOMMITTED_GIT_DIFF_SELECTION) {
    return { type: "uncommitted" };
  }
  if (selection === COMMITTED_GIT_DIFF_SELECTION) {
    return mergeBaseBranch
      ? { type: "branch_committed", mergeBaseBranch }
      : undefined;
  }
  if (selection) return { type: "commit", sha: selection };
  return mergeBaseBranch ? { type: "all", mergeBaseBranch } : undefined;
}

export function buildGitDiffSelectionOptions(
  commits: readonly WorkspaceCommitSummary[],
  hasUncommittedChanges: boolean,
): GitDiffSelectionOption[] {
  return [
    { value: ALL_GIT_DIFF_SELECTION, label: "All changes" },
    ...(commits.length > 0
      ? [{ value: COMMITTED_GIT_DIFF_SELECTION, label: "Committed changes" }]
      : []),
    ...(hasUncommittedChanges
      ? [
          {
            value: UNCOMMITTED_GIT_DIFF_SELECTION,
            label: "Uncommitted changes",
          },
        ]
      : []),
    ...commits.map((commit) => ({
      value: commit.sha,
      label: commit.subject,
      monoPrefix: commit.shortSha,
    })),
  ];
}

export function shouldResetGitDiffSelection(
  selection: string | null,
  commits: readonly WorkspaceCommitSummary[],
  hasUncommittedChanges: boolean,
): boolean {
  if (!selection) return false;
  if (selection === COMMITTED_GIT_DIFF_SELECTION) return commits.length === 0;
  if (selection === UNCOMMITTED_GIT_DIFF_SELECTION) {
    return !hasUncommittedChanges;
  }
  return !commits.some((commit) => commit.sha === selection);
}

type DiffFilePathMatcher = (path: string) => boolean;

function compileGlob(patterns: string | string[], basename: boolean) {
  return picomatch(patterns, { basename, dot: true, nocase: true });
}

function compileDiffFilePattern(pattern: string): {
  exact: DiffFilePathMatcher;
  partial: DiffFilePathMatcher;
} {
  if (!picomatch.scan(pattern).isGlob) {
    const needle = pattern.toLowerCase();
    const matcher = (path: string) => path.toLowerCase().includes(needle);
    return { exact: matcher, partial: matcher };
  }
  const hasSlash = pattern.includes("/");
  return {
    exact: compileGlob(pattern, !hasSlash),
    partial: hasSlash
      ? compileGlob([`${pattern}*`, `${pattern}*/**`], false)
      : compileGlob(`${pattern}*`, true),
  };
}

export function filterDiffFilesByPath(
  files: readonly DiffFileEntry[],
  query: string,
): readonly DiffFileEntry[] {
  const patterns = query
    .split(",")
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern !== "" && pattern !== "!");
  if (patterns.length === 0) {
    return files;
  }
  const fileMatches = (file: DiffFileEntry, isMatch: DiffFilePathMatcher) =>
    [file.path, file.previousPath].some(
      (path) => path !== null && isMatch(path),
    );
  const included = patterns
    .filter((pattern) => !pattern.startsWith("!"))
    .map((pattern) => {
      const { exact, partial } = compileDiffFilePattern(pattern);
      return files.some((file) => fileMatches(file, exact)) ? exact : partial;
    });
  const candidates =
    included.length === 0
      ? files
      : files.filter((file) =>
          included.some((isMatch) => fileMatches(file, isMatch)),
        );
  const excluded = patterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => compileDiffFilePattern(pattern.slice(1)).exact)
    .filter(
      (isMatch) => !candidates.every((file) => fileMatches(file, isMatch)),
    );
  if (excluded.length === 0) {
    return candidates;
  }
  return candidates.filter(
    (file) => !excluded.some((isMatch) => fileMatches(file, isMatch)),
  );
}
