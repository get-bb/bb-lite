import { useCallback, useEffect, useMemo, useState } from "react";
import {
  resolveEnvironmentMergeBaseBranch,
  type Environment,
  type GitBranchRefClassification,
  type Thread,
} from "@bb/domain";
import {
  createFilePreviewLineRange,
  getFilePreviewLineRangeStart,
  type HostFileTabState,
  type WorkspaceFileTabState,
} from "@bb/client-core";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import { usePublishThreadPanelOpener } from "@/components/plugin/plugin-thread-panel-navigation";
import type {
  ThreadTimelineLocalFileLink,
  ThreadTimelineOpenPluginPanelHandler,
} from "@/components/thread/timeline";
import { appToast } from "@/components/ui/app-toast";
import type { MarkdownLocalFileContextMenuItem } from "@/components/ui/markdown-link-routing";
import type { WorkspaceChangedFileSelection } from "@/components/workspace/workspace-change-summary";
import { useEnvironmentMergeBaseBranches } from "@/hooks/queries/environment-queries";
import {
  useCloseTerminal,
  useCreateTerminal,
  useTerminals,
} from "@/hooks/queries/thread-terminal-queries";
import type { useOpenTargets } from "@/hooks/useOpenTargets";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { getFileBasename } from "@/lib/live-file-navigation";
import { serializePluginPanelParams } from "@/lib/plugin-json-value";
import { resolveThreadLocalFileLink } from "@/lib/thread-local-file-links";
import { openHttpUrlInExternalBrowser } from "@/lib/url-open-routing";
import { wsManager } from "@/lib/ws";
import { usePluginSlots } from "@/plugins/registry";
import {
  buildOpenInEditorHandler,
  resolveWorkspaceChangedFileOpenTarget,
} from "@/views/thread-detail/threadWorkspaceOpenPath";
import { resolveGitDiffTabStatus } from "./gitDiffTabEligibility";
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
  environmentLoadFailed: boolean;
  executionUnavailable: boolean;
  hostConnected: boolean;
  isFocused: boolean;
  openTargets: ReturnType<typeof useOpenTargets>;
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

function copyFileText(text: string, what: string): void {
  void copyToClipboardWithToast(text, {
    successMessage: `File ${what} copied`,
    errorMessage: `Failed to copy file ${what}`,
  });
}

export function openThreadLink({ href }: { href: string }) {
  return openHttpUrlInExternalBrowser(href);
}

export type ThreadPanelController = ReturnType<typeof useThreadPanel>;

export function useThreadPanel({
  threadId,
  thread,
  environment,
  environmentLoadFailed,
  executionUnavailable,
  hostConnected,
  isFocused,
  openTargets,
}: UseThreadPanelArgs) {
  const environmentId = thread?.environmentId ?? null;
  const workspaceRootPath = environment?.path ?? null;
  const gitDiffTabStatus = resolveGitDiffTabStatus({
    environmentId,
    environmentIsGitRepo: environment?.isGitRepo,
    environmentLoadFailed,
    environmentOwnsPath: environment?.managed,
    hasResolvedThread: thread !== undefined,
    threadArchived: thread?.archivedAt != null || executionUnavailable,
  });
  const canUseGitUi = !executionUnavailable && gitDiffTabStatus === "eligible";
  const canCreateTerminal =
    !executionUnavailable &&
    environmentId !== null &&
    environment?.status === "ready" &&
    hostConnected;
  const tabs = usePanelTabs({
    panelId: threadId,
    synced: true,
    fixedIds:
      gitDiffTabStatus === "ineligible"
        ? THREAD_INFO_ONLY_TAB_IDS
        : THREAD_FIXED_TAB_IDS,
  });
  const {
    activate: activateTab,
    close,
    open: openTab,
    setOpen: setPersistedOpen,
  } = tabs;
  const isCompactViewport = useIsCompactViewport();
  const [drawerThreadId, setDrawerThreadId] = useState<string | null>(null);
  useEffect(() => {
    setDrawerThreadId(null);
  }, [threadId]);
  useEffect(() => {
    if (!isCompactViewport) setDrawerThreadId(null);
  }, [isCompactViewport]);
  const isOpen = isCompactViewport ? drawerThreadId === threadId : tabs.isOpen;
  const openCompactDrawer = useCallback(() => {
    if (isCompactViewport) setDrawerThreadId(threadId);
  }, [isCompactViewport, threadId]);
  const open = useCallback(
    (...args: Parameters<typeof openTab>) => {
      openTab(...args);
      openCompactDrawer();
    },
    [openCompactDrawer, openTab],
  );
  const activate = useCallback(
    (tabId: string) => {
      activateTab(tabId);
      openCompactDrawer();
    },
    [activateTab, openCompactDrawer],
  );
  const setOpen = useCallback(
    (next: boolean) => {
      if (isCompactViewport) setDrawerThreadId(next ? threadId : null);
      else setPersistedOpen(next);
    },
    [isCompactViewport, setPersistedOpen, threadId],
  );
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
  const { threadPanels } = usePluginSlots();

  const openWorkspaceFile = useCallback(
    (file: WorkspaceFileTabState, replaceNewTab = false) => {
      if (environmentId === null) return;
      open(workspaceFileTab(file, environmentId), replaceNewTab);
    },
    [environmentId, open],
  );
  const previewWorkspaceFile = (path: string, replaceNewTab = false) =>
    openWorkspaceFile(
      {
        lineRange: null,
        path,
        source: { kind: "working-tree" },
        statusLabel: null,
      },
      replaceNewTab,
    );
  const openHostFile = (file: HostFileTabState) => {
    if (environmentId !== null)
      open(hostFileTab(file, environmentId, threadId));
  };
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
  const openPluginPanel = useCallback(
    (args: Parameters<typeof pluginPanelTab>[0]) =>
      open(pluginPanelTab(args), true),
    [open],
  );
  const openPluginPanelFromTimeline: ThreadTimelineOpenPluginPanelHandler = ({
    pluginId,
    actionId,
    title,
    params,
  }) => {
    const action = threadPanels.find(
      (candidate) =>
        candidate.pluginId === pluginId && candidate.id === actionId,
    );
    if (action === undefined) return false;
    try {
      const paramsJson = serializePluginPanelParams(params);
      openPluginPanel({
        pluginId,
        actionId,
        title: title ?? action.title,
        paramsJson,
      });
      return true;
    } catch (error) {
      console.warn(
        `[plugin:${pluginId}] messageDirective openThreadPanel params are invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  };
  usePublishThreadPanelOpener(openPluginPanelFromTimeline, isFocused);
  const openLocalFileLink = (link: ThreadTimelineLocalFileLink) => {
    const resolution = resolveThreadLocalFileLink({
      hostFileLinksAvailable: environmentId !== null,
      link,
      workspaceRootPath,
    });
    if (resolution.kind === "app-route") return false;
    if (resolution.kind === "error") {
      appToast.error("Failed to open file locally", {
        description: resolution.description,
      });
    } else if (resolution.kind === "open-workspace-path") {
      openWorkspaceFile({
        lineRange: resolution.request.lineRange,
        path: resolution.request.relativePath,
        source: { kind: "working-tree" },
        statusLabel: null,
      });
    } else openHostFile(resolution.request);
    return true;
  };
  const localFileContextMenuItems = (link: ThreadTimelineLocalFileLink) => {
    const lineNumber = getFilePreviewLineRangeStart({
      lineRange: link.lineRange,
    });
    const items: MarkdownLocalFileContextMenuItem[] = [
      {
        id: "copy-path",
        label: "Copy file path",
        onSelect: () => copyFileText(link.path, "path"),
      },
      {
        id: "copy-name",
        label: "Copy file name",
        onSelect: () => copyFileText(getFileBasename(link.path), "name"),
      },
    ];
    if (openTargets.fileTargets.length > 0) {
      items.unshift(
        {
          id: "open-in",
          items: openTargets.fileTargets.map((target) => ({
            id: `open-target:${target.id}`,
            label: `Open in ${target.label}`,
            onSelect: () => {
              void openTargets.openPath(target, {
                lineNumber,
                path: link.path,
              });
            },
          })),
          label: "Open in",
          type: "submenu",
        },
        { id: "copy-separator", type: "separator" },
      );
    }
    return items;
  };

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
  const openGitDiff = (target: Omit<PendingGitDiff, "threadId">) => {
    if (!canUseGitUi) return;
    setPendingGitDiff({ ...target, threadId });
    activate(GIT_DIFF_TAB_ID);
  };
  const openDiffFile = (path: string) => {
    if (path.length > 0) openGitDiff({ path });
  };
  const openCommitDiff = (commitSha: string) => {
    if (commitSha.length > 0) openGitDiff({ commitSha });
  };
  const openChangedFile = (selection: WorkspaceChangedFileSelection) => {
    const target = resolveWorkspaceChangedFileOpenTarget(selection);
    if (target.kind === "diff") return openDiffFile(selection.file.path);
    openWorkspaceFile({
      lineRange: null,
      path: selection.file.path,
      source: target.source,
      statusLabel: target.statusLabel,
    });
  };
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
    isFocused,
    toggle,
    close: closePanel,
    gitDiffTabStatus,
    canUseGitUi,
    canCreateTerminal,
    terminalSessions,
    focusRequest,
    setFocusRequest,
    previewWorkspaceFile,
    openNewTab,
    openPluginPanel,
    openPluginPanelFromTimeline,
    openLocalFileLink,
    localFileContextMenuItems,
    openFileInEditor: buildOpenInEditorHandler({
      rootPath: workspaceRootPath,
      openInPreferredTarget: openTargets.openInPreferredFileTarget,
    }),
    openInPreferredFileTarget: openTargets.openInPreferredFileTarget,
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
