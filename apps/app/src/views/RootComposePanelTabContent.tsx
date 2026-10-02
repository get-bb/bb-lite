import { useMemo } from "react";
import type { OpenInTargetContext } from "@bb/host-daemon-contract";
import type { SidebarProject } from "@/hooks/queries/project-queries";
import { findLocalPathProjectSourceForHost } from "@bb/domain";
import type { SecondaryFileFixedPanelTab } from "@/lib/fixed-panel-tabs-state";
import type { SecondaryPanelPaneRenderContext } from "@/components/secondary-panel/ThreadSecondaryPanel";
import { FilePreview } from "@/components/secondary-panel/FilePreview";
import { LazyThreadTerminalPanel } from "@/components/secondary-panel/lazySecondaryPanelComponents";
import { NewTabPage } from "@/components/secondary-panel/NewTabPage";
import {
  HostFilePreviewTabContent,
  ProjectFilePreviewTabContent,
  ThreadStorageFilePreviewTabContent,
  WorkspaceFilePreviewTabContent,
} from "@/components/secondary-panel/ThreadSecondaryPanelTabContent";
import type { FileSearchSelection } from "@/components/secondary-panel/useThreadFileTabs";
import { PluginPanelTabContent } from "@/components/plugin/PluginPanelActions";
import { useEnvironment } from "@/hooks/queries/environment-queries";
import { useThreadStorageLocation } from "@/hooks/queries/thread-queries";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { useLocalOpenTargets } from "@/hooks/useLocalOpenTargets";
import {
  buildOpenInEditorHandler,
  resolveEnvironmentOpenContext,
} from "./thread-detail/threadWorkspaceOpenPath";
import { getFilePreviewLineRangeStart } from "@bb/client-core";
import { resolveAbsoluteFilePath } from "@/lib/absolute-file-path";
import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";

export const ROOT_COMPOSE_FIXED_PANEL_STATE_ID = "root-compose";

export type RootComposeTerminalTarget =
  | { kind: "environment"; environmentId: string }
  | { kind: "host_path"; cwd: string | null; hostId: string };

interface RootComposePanelTabContentProps {
  activeTabId: string | null;
  canCreateTerminal: boolean;
  currentProjectId: string;
  isPanelOpen: boolean;
  isProjectless: boolean;
  onActivateTab: (tabId: string) => void;
  onAutoFocusNewTabHandled: () => void;
  onAutoFocusTerminalHandled: () => void;
  onSelectFileSearchResult: (selection: FileSearchSelection) => void;
  onSelectionAddToChat: (text: string) => void;
  onStartTerminal: () => void;
  pane: SecondaryPanelPaneRenderContext;
  primaryHostId: string | null;
  projectSources: SidebarProject["sources"];
  projects: readonly SidebarProject[] | undefined;
  rootPanelEnvironmentId: string | null;
  rootPanelThreadId: string | null;
  rootProjectHostId: string | null;
  shouldAutoFocusNewTab: boolean;
  shouldAutoFocusTerminal: boolean;
  tab: SecondaryFileFixedPanelTab;
  terminalTarget: RootComposeTerminalTarget | null;
}

interface RootComposeFilePreviewTabContentProps {
  currentProjectId: string;
  isFocused: boolean;
  isPanelOpen: boolean;
  onSelectionAddToChat: (text: string) => void;
  primaryHostId: string | null;
  projectSources: SidebarProject["sources"];
  projects: readonly SidebarProject[] | undefined;
  rootPanelEnvironmentId: string | null;
  rootPanelThreadId: string | null;
  rootProjectHostId: string | null;
  tab: Extract<
    SecondaryFileFixedPanelTab,
    {
      kind:
        | "workspace-file-preview"
        | "host-file-preview"
        | "thread-storage-file-preview";
    }
  >;
}

function resolveHostOpenContext(args: {
  hostId: string | null;
  isLocal: boolean;
  serverOrigin: string;
}): OpenInTargetContext | null {
  if (args.hostId === null) return null;
  if (args.isLocal) return { kind: "local" };
  return {
    kind: "remote-ssh",
    serverOrigin: args.serverOrigin,
    hostId: args.hostId,
  };
}

export function RootComposePanelTabContent({
  activeTabId,
  canCreateTerminal,
  currentProjectId,
  isPanelOpen,
  isProjectless,
  onActivateTab,
  onAutoFocusNewTabHandled,
  onAutoFocusTerminalHandled,
  onSelectFileSearchResult,
  onSelectionAddToChat,
  onStartTerminal,
  pane,
  primaryHostId,
  projectSources,
  projects,
  rootPanelEnvironmentId,
  rootPanelThreadId,
  rootProjectHostId,
  shouldAutoFocusNewTab,
  shouldAutoFocusTerminal,
  tab,
  terminalTarget,
}: RootComposePanelTabContentProps) {
  switch (tab.kind) {
    case "terminal":
      return terminalTarget === null ? null : (
        <LazyThreadTerminalPanel
          autoFocus={
            pane.isFocused && tab.id === activeTabId && shouldAutoFocusTerminal
          }
          canCreateTerminal={canCreateTerminal}
          isPanelOpen={isPanelOpen}
          onAutoFocusHandled={onAutoFocusTerminalHandled}
          onSelectionAddToChat={onSelectionAddToChat}
          panelStateId={ROOT_COMPOSE_FIXED_PANEL_STATE_ID}
          syncThreadId={null}
          target={terminalTarget}
          terminalId={tab.terminalId}
        />
      );
    case "new-tab":
      return (
        <NewTabPage
          autoFocus={
            pane.isFocused && tab.id === activeTabId && shouldAutoFocusNewTab
          }
          projectId={isProjectless ? undefined : currentProjectId}
          environmentId={rootPanelEnvironmentId}
          hostId={rootProjectHostId}
          currentThreadId={rootPanelThreadId ?? ""}
          onAutoFocusHandled={onAutoFocusNewTabHandled}
          onSelect={(selection) => {
            onActivateTab(tab.id);
            onSelectFileSearchResult(selection);
          }}
          recentItemsThreadId={ROOT_COMPOSE_FIXED_PANEL_STATE_ID}
          onStartTerminal={
            canCreateTerminal
              ? () => {
                  onActivateTab(tab.id);
                  onStartTerminal();
                }
              : undefined
          }
          showFileSearch={!isProjectless}
        />
      );
    case "workspace-file-preview":
    case "host-file-preview":
    case "thread-storage-file-preview":
      return (
        <RootComposeFilePreviewTabContent
          currentProjectId={currentProjectId}
          isFocused={pane.isFocused}
          isPanelOpen={isPanelOpen}
          onSelectionAddToChat={onSelectionAddToChat}
          primaryHostId={primaryHostId}
          projectSources={projectSources}
          projects={projects}
          rootPanelEnvironmentId={rootPanelEnvironmentId}
          rootPanelThreadId={rootPanelThreadId}
          rootProjectHostId={rootProjectHostId}
          tab={tab}
        />
      );
    case "plugin-panel":
      return (
        <PluginPanelTabContent tab={tab} context={{ kind: "new-thread" }} />
      );
  }
}

function RootComposeFilePreviewTabContent({
  currentProjectId,
  isFocused,
  isPanelOpen,
  onSelectionAddToChat,
  primaryHostId,
  projectSources,
  projects,
  rootPanelEnvironmentId,
  rootPanelThreadId,
  rootProjectHostId,
  tab,
}: RootComposeFilePreviewTabContentProps) {
  const environmentId = tab.environmentId ?? rootPanelEnvironmentId;
  const environmentQuery = useEnvironment(environmentId, {
    enabled: environmentId !== null,
    staleTime: 5_000,
  });
  const environment = environmentQuery.data;
  const storageThreadId =
    tab.kind === "thread-storage-file-preview"
      ? (tab.threadId ?? rootPanelThreadId)
      : null;
  const threadStorageLocationQuery = useThreadStorageLocation(
    storageThreadId ?? "",
    { enabled: storageThreadId !== null },
  );
  const threadStorageRootPath =
    threadStorageLocationQuery.data?.storageRootPath ?? null;
  const projectPreviewId =
    tab.kind === "workspace-file-preview" && tab.environmentId === null
      ? (tab.projectId ?? currentProjectId)
      : null;
  const previewProjectSources =
    projectPreviewId === null
      ? []
      : projectPreviewId === currentProjectId
        ? projectSources
        : (projects?.find((project) => project.id === projectPreviewId)
            ?.sources ?? []);
  const projectSourceRoutingHostId =
    rootPanelEnvironmentId === null
      ? (rootProjectHostId ?? primaryHostId)
      : null;
  const projectPreviewRootPath =
    projectPreviewId === null
      ? null
      : rootPanelEnvironmentId !== null
        ? (environment?.path ?? null)
        : projectSourceRoutingHostId !== null
          ? (findLocalPathProjectSourceForHost(
              previewProjectSources,
              projectSourceRoutingHostId,
            )?.path ?? null)
          : null;
  const projectPreviewHostId =
    projectPreviewRootPath === null
      ? null
      : rootPanelEnvironmentId !== null
        ? (environment?.hostId ?? null)
        : projectSourceRoutingHostId;
  const { isLocalDaemonHost } = useHostDaemon();
  const serverOrigin = window.location.origin;
  const environmentOpenContext = resolveEnvironmentOpenContext({
    environment,
    threadEnvironmentIsLocal: environment
      ? isLocalDaemonHost(environment.hostId)
      : false,
    serverOrigin,
  });
  const projectOpenContext = resolveHostOpenContext({
    hostId: projectPreviewHostId,
    isLocal: isLocalDaemonHost(projectPreviewHostId),
    serverOrigin,
  });
  const openContext =
    tab.kind === "workspace-file-preview" && tab.environmentId === null
      ? projectOpenContext
      : environmentOpenContext;
  const { canOpenPreferredFileTarget, openPathInPreferredFileTarget } =
    useLocalOpenTargets({
      enabled: openContext !== null,
      ...(openContext ? { openContext } : {}),
    });
  const workspaceRootPath = environment?.path ?? null;
  const relativeFileRootPath =
    tab.kind === "workspace-file-preview"
      ? tab.environmentId === null
        ? projectPreviewRootPath
        : workspaceRootPath
      : tab.kind === "thread-storage-file-preview"
        ? threadStorageRootPath
        : null;
  const openRelativeFileInEditor = useMemo(
    () =>
      buildOpenInEditorHandler({
        rootPath: relativeFileRootPath,
        canOpenPreferredTarget: canOpenPreferredFileTarget,
        openInPreferredTarget: openPathInPreferredFileTarget,
      }),
    [
      canOpenPreferredFileTarget,
      openPathInPreferredFileTarget,
      relativeFileRootPath,
    ],
  );
  const hostFileLineNumber = getFilePreviewLineRangeStart({
    lineRange: tab.kind === "host-file-preview" ? tab.lineRange : null,
  });
  const openHostFileInEditor =
    tab.kind === "host-file-preview" && canOpenPreferredFileTarget
      ? (path: string) => {
          void openPathInPreferredFileTarget({
            lineNumber: hostFileLineNumber,
            path,
          });
        }
      : undefined;
  const onOpenInEditor =
    tab.kind === "host-file-preview"
      ? openHostFileInEditor
      : openRelativeFileInEditor;

  useAppCommandHandler("workspace.openPreferred", () => {
    if (!isFocused || onOpenInEditor === undefined) return false;
    onOpenInEditor(tab.path);
    return true;
  });

  switch (tab.kind) {
    case "workspace-file-preview": {
      const copyPath = resolveAbsoluteFilePath({
        path: tab.path,
        rootPath:
          tab.environmentId === null
            ? projectPreviewRootPath
            : workspaceRootPath,
      });
      return tab.environmentId !== null ? (
        <WorkspaceFilePreviewTabContent
          activePath={tab.path}
          copyPath={copyPath}
          environmentId={tab.environmentId}
          isPanelOpen={isPanelOpen}
          lineRange={tab.lineRange}
          onOpenInEditor={onOpenInEditor}
          onSelectionAddToChat={onSelectionAddToChat}
          source={tab.source}
          statusLabel={tab.statusLabel}
          threadId={rootPanelThreadId}
        />
      ) : projectPreviewId !== null ? (
        <ProjectFilePreviewTabContent
          activePath={tab.path}
          copyPath={copyPath}
          environmentId={rootPanelEnvironmentId}
          hostId={rootProjectHostId}
          isPanelOpen={isPanelOpen}
          lineRange={tab.lineRange}
          onOpenInEditor={onOpenInEditor}
          onSelectionAddToChat={onSelectionAddToChat}
          projectId={projectPreviewId}
          rootPath={projectPreviewRootPath}
          threadId={rootPanelThreadId}
        />
      ) : (
        <FilePreview
          path={tab.path}
          copyPath={copyPath}
          onOpenInEditor={onOpenInEditor}
          state={{ kind: "loading" }}
        />
      );
    }
    case "host-file-preview": {
      const threadId = tab.threadId ?? rootPanelThreadId;
      return threadId && environmentId ? (
        <HostFilePreviewTabContent
          activePath={tab.path}
          copyPath={tab.path}
          environmentId={environmentId}
          isPanelOpen={isPanelOpen}
          lineRange={tab.lineRange}
          onOpenInEditor={onOpenInEditor}
          onSelectionAddToChat={onSelectionAddToChat}
          threadId={threadId}
        />
      ) : (
        <FilePreview
          path={tab.path}
          copyPath={tab.path}
          onOpenInEditor={onOpenInEditor}
          state={{ kind: "loading" }}
        />
      );
    }
    case "thread-storage-file-preview": {
      const copyPath = resolveAbsoluteFilePath({
        path: tab.path,
        rootPath: threadStorageRootPath,
      });
      return storageThreadId ? (
        <ThreadStorageFilePreviewTabContent
          activePath={tab.path}
          copyPath={copyPath}
          isPanelOpen={isPanelOpen}
          lineRange={tab.lineRange}
          onOpenInEditor={onOpenInEditor}
          onSelectionAddToChat={onSelectionAddToChat}
          threadId={storageThreadId}
        />
      ) : (
        <FilePreview
          path={tab.path}
          copyPath={copyPath}
          onOpenInEditor={onOpenInEditor}
          state={{ kind: "loading" }}
        />
      );
    }
  }
}
