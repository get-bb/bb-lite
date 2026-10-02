import { useCallback, useEffect, useMemo, useState } from "react";
import {
  resolveEnvironmentMergeBaseBranch,
  type Environment,
  type GitBranchRefClassification,
  type Thread,
} from "@bb/domain";
import {
  createFilePreviewLineRange,
  type HostFileTabState,
  type WorkspaceFileTabState,
} from "@bb/client-core";
import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import type { WorkspaceChangedFileSelection } from "@/components/workspace/workspace-change-summary";
import { useEnvironmentMergeBaseBranches } from "@/hooks/queries/environment-queries";
import {
  useCloseTerminal,
  useCreateTerminal,
  useTerminals,
} from "@/hooks/queries/thread-terminal-queries";
import { wsManager } from "@/lib/ws";
import { resolveWorkspaceChangedFileOpenTarget } from "@/views/thread-detail/threadWorkspaceOpenPath";
import {
  GIT_DIFF_TAB_ID,
  hostFileTab,
  NEW_TAB,
  pluginPanelTab,
  terminalTab,
  THREAD_INFO_TAB_ID,
  usePanelTabs,
  useTerminalTabSync,
  workspaceFileTab,
} from "./panelTabs";

export const DEFAULT_TERMINAL_COLS = 100;
export const DEFAULT_TERMINAL_ROWS = 30;
const THREAD_FIXED_TAB_IDS = [THREAD_INFO_TAB_ID, GIT_DIFF_TAB_ID];
const THREAD_INFO_ONLY_TAB_IDS = [THREAD_INFO_TAB_ID];

interface UseThreadPanelArgs {
  threadId: string;
  thread: Thread | undefined;
  environment: Environment | undefined;
  isFocused: boolean;
  canUseGitUi: boolean;
  canCreateTerminal: boolean;
  showsGitDiffTab: boolean;
}

interface PendingGitDiff {
  threadId: string;
  commitSha?: string;
  path?: string;
}

function withSelectedBranch(
  list: string[] | undefined,
  selected: GitBranchRefClassification | null | undefined,
  kind: "local" | "remote",
): string[] | undefined {
  return list !== undefined &&
    selected?.kind === kind &&
    !list.includes(selected.name)
    ? [selected.name, ...list]
    : list;
}

export type ThreadPanelController = ReturnType<typeof useThreadPanel>;

export function useThreadPanel({
  threadId,
  thread,
  environment,
  isFocused,
  canUseGitUi,
  canCreateTerminal,
  showsGitDiffTab,
}: UseThreadPanelArgs) {
  const environmentId = thread?.environmentId ?? null;
  const tabs = usePanelTabs({
    panelId: threadId,
    synced: true,
    fixedIds: showsGitDiffTab ? THREAD_FIXED_TAB_IDS : THREAD_INFO_ONLY_TAB_IDS,
  });
  const { activate, close, isOpen, open, setOpen } = tabs;
  const terminalSessions = useTerminals(
    { kind: "thread", threadId },
    { enabled: isOpen },
  ).data?.sessions;
  useTerminalTabSync(tabs.update, tabs.isSynced ? terminalSessions : undefined);
  const createTerminal = useCreateTerminal();
  const closeTerminalSession = useCloseTerminal();
  const [focusRequest, setFocusRequest] = useState<
    "new-tab" | "terminal" | null
  >(null);

  const openWorkspaceFile = useCallback(
    (file: WorkspaceFileTabState, replaceNewTab = false) => {
      if (environmentId === null) return;
      open(workspaceFileTab(file, environmentId, null), replaceNewTab);
    },
    [environmentId, open],
  );
  const openHostFile = useCallback(
    (file: HostFileTabState) => {
      if (environmentId === null) return;
      open(hostFileTab(file, environmentId, threadId));
    },
    [environmentId, open, threadId],
  );
  const openNewTab = useCallback(() => {
    open(NEW_TAB);
    setFocusRequest("new-tab");
  }, [open]);
  const startTerminal = useCallback(() => {
    if (!canCreateTerminal || createTerminal.isPending) return false;
    void createTerminal
      .mutateAsync({
        target: { kind: "thread", threadId },
        cols: DEFAULT_TERMINAL_COLS,
        rows: DEFAULT_TERMINAL_ROWS,
      })
      .then((session) => {
        setFocusRequest("terminal");
        open(terminalTab(session.id), true);
      })
      .catch(() => undefined);
    return true;
  }, [canCreateTerminal, createTerminal, open, threadId]);
  const closeTerminal = useCallback(
    (terminalId: string) =>
      closeTerminalSession.mutate(
        { mode: "force", terminalId },
        { onSuccess: () => close(terminalTab(terminalId).id) },
      ),
    [close, closeTerminalSession],
  );

  useEffect(() => {
    if (thread === undefined) return;
    const apply = () => {
      const file = wsManager.consumePendingOpenFile(threadId);
      if (file?.source !== "workspace") return;
      openWorkspaceFile({
        lineRange:
          file.lineNumber === null
            ? null
            : createFilePreviewLineRange({
                startLineNumber: file.lineNumber,
                endLineNumber: file.lineNumber,
              }),
        path: file.path,
        source: { kind: "working-tree" },
        statusLabel: null,
      });
    };
    apply();
    return wsManager.onThreadOpen((signal) => {
      if (signal.threadId === threadId) apply();
    });
  }, [openWorkspaceFile, thread, threadId]);

  const gitEnvironmentId = canUseGitUi ? (environmentId ?? "") : "";
  const [mergeBaseSelection, setMergeBaseSelection] = useState<{
    branch?: string;
    environmentId: string;
  }>({ environmentId: gitEnvironmentId });
  const selectedMergeBaseBranch =
    mergeBaseSelection.environmentId === gitEnvironmentId
      ? mergeBaseSelection.branch
      : undefined;
  const setSelectedMergeBaseBranch = useCallback(
    (branch: string | undefined) =>
      setMergeBaseSelection({ branch, environmentId: gitEnvironmentId }),
    [gitEnvironmentId],
  );
  const [pendingGitDiff, setPendingGitDiff] = useState<PendingGitDiff | null>(
    null,
  );
  const [branchSearchQuery, setMergeBaseBranchSearchQuery] = useState("");
  const [branchOptionsRequested, setBranchOptionsRequested] = useState(false);
  useEffect(() => {
    setPendingGitDiff(null);
    setMergeBaseBranchSearchQuery("");
    setBranchOptionsRequested(false);
  }, [gitEnvironmentId, threadId]);
  const requestedMergeBaseBranch =
    selectedMergeBaseBranch ?? resolveEnvironmentMergeBaseBranch(environment);
  const isGitDiffActive = isOpen && tabs.activeTabId === GIT_DIFF_TAB_ID;
  const branchesQuery = useEnvironmentMergeBaseBranches(gitEnvironmentId, {
    enabled: branchOptionsRequested || isGitDiffActive,
    query: branchSearchQuery,
    selectedBranch: requestedMergeBaseBranch,
  });
  const selectedMergeBaseBranchRef = branchesQuery.data?.selectedBranch;
  const branches = branchesQuery.data?.branches;
  const remoteBranches = branchesQuery.data?.remoteBranches;
  const mergeBaseBranchOptions = useMemo(
    () => withSelectedBranch(branches, selectedMergeBaseBranchRef, "local"),
    [branches, selectedMergeBaseBranchRef],
  );
  const mergeBaseRemoteBranchOptions = useMemo(
    () =>
      withSelectedBranch(remoteBranches, selectedMergeBaseBranchRef, "remote"),
    [remoteBranches, selectedMergeBaseBranchRef],
  );
  const onMergeBasePickerOpenChange = useCallback((pickerOpen: boolean) => {
    if (pickerOpen) setBranchOptionsRequested(true);
  }, []);
  const clearPendingGitDiff = useCallback(() => setPendingGitDiff(null), []);
  const openGitDiff = useCallback(
    (target: Omit<PendingGitDiff, "threadId"> = {}) => {
      if (!canUseGitUi) return;
      setPendingGitDiff({ ...target, threadId });
      activate(GIT_DIFF_TAB_ID);
    },
    [activate, canUseGitUi, threadId],
  );
  const openDiffFile = useCallback(
    (path: string) => openGitDiff({ path }),
    [openGitDiff],
  );
  const openCommitDiff = useCallback(
    (commitSha: string) => openGitDiff({ commitSha }),
    [openGitDiff],
  );
  const openChangedFile = useCallback(
    (selection: WorkspaceChangedFileSelection) => {
      const target = resolveWorkspaceChangedFileOpenTarget(selection);
      if (target.kind === "diff") {
        openDiffFile(selection.file.path);
        return;
      }
      openWorkspaceFile({
        lineRange: null,
        path: selection.file.path,
        source: target.source,
        statusLabel: target.statusLabel,
      });
    },
    [openDiffFile, openWorkspaceFile],
  );
  const toggle = useCallback(() => setOpen(!isOpen), [isOpen, setOpen]);
  const closePanel = useCallback(() => setOpen(false), [setOpen]);

  const whenFocused = (run: () => boolean | void) => () =>
    isFocused && run() !== false;
  useAppCommandHandler("panel.newTab", whenFocused(openNewTab));
  useAppCommandHandler("file.quickOpen", whenFocused(openNewTab));
  useAppCommandHandler("panel.toggle", whenFocused(toggle));
  useAppCommandHandler("terminal.open", whenFocused(startTerminal));
  useAppCommandHandler(
    "panel.close",
    whenFocused(() => {
      if (!isOpen) return false;
      if (tabs.activeTab?.kind === "terminal") {
        closeTerminal(tabs.activeTab.terminalId);
      } else if (tabs.activeTab !== null) close(tabs.activeTab.id);
      else closePanel();
    }),
  );
  useAppCommandHandler(
    "diff.toggle",
    whenFocused(() => {
      if (!canUseGitUi) return false;
      if (isGitDiffActive) closePanel();
      else activate(GIT_DIFF_TAB_ID);
    }),
  );

  const pending = pendingGitDiff?.threadId === threadId ? pendingGitDiff : null;
  return {
    tabs,
    isOpen,
    toggle,
    close: closePanel,
    terminalSessions,
    focusRequest,
    setFocusRequest,
    openWorkspaceFile,
    openHostFile,
    openNewTab,
    openPluginPanel: useCallback(
      (args: Parameters<typeof pluginPanelTab>[0]) =>
        open(pluginPanelTab(args), true),
      [open],
    ),
    startTerminal,
    closeTerminal,
    openDiffFile,
    openCommitDiff,
    openChangedFile,
    pendingGitDiffCommitSha: pending?.commitSha ?? null,
    pendingGitDiffScrollPath: pending?.path ?? null,
    clearPendingGitDiff,
    requestedMergeBaseBranch,
    selectedMergeBaseBranch,
    selectedMergeBaseBranchRef,
    setSelectedMergeBaseBranch,
    mergeBaseBranchOptions,
    mergeBaseRemoteBranchOptions,
    isLoadingMergeBaseBranchOptions: branchesQuery.isFetching,
    setMergeBaseBranchSearchQuery,
    onMergeBasePickerOpenChange,
  };
}
