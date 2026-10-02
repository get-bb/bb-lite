import { useMemo } from "react";
import type { SidebarProject } from "@/hooks/queries/project-queries";
import { findLocalPathProjectSourceForHost } from "@bb/domain";
import type { TerminalSession } from "@bb/server-contract";
import type { PanelTab } from "@/components/secondary-panel/panelTabs";
import { FilePreview } from "@/components/secondary-panel/FilePreview";
import { ThreadTerminalPanel } from "@/components/thread/terminal/ThreadTerminalPanel";
import { NewTabPage } from "@/components/secondary-panel/NewTabPage";
import {
  HostFilePreviewTabContent,
  ProjectFilePreviewTabContent,
  WorkspaceFilePreviewTabContent,
} from "@/components/secondary-panel/ThreadSecondaryPanelTabContent";
import { PluginPanelTabContent } from "@/components/plugin/PluginPanelActions";
import { useEnvironment } from "@/hooks/queries/environment-queries";
import { useOpenTargets } from "@/hooks/useOpenTargets";
import { buildOpenInEditorHandler } from "./thread-detail/threadWorkspaceOpenPath";
import { getFilePreviewLineRangeStart } from "@bb/client-core";
import { resolveAbsoluteFilePath } from "@/lib/absolute-file-path";

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
  onSelectFileSearchResult: (path: string) => void;
  onStartTerminal: () => void;
  primaryHostId: string | null;
  projectSources: SidebarProject["sources"];
  projects: readonly SidebarProject[] | undefined;
  rootPanelEnvironmentId: string | null;
  rootPanelThreadId: string | null;
  rootProjectHostId: string | null;
  shouldAutoFocusNewTab: boolean;
  shouldAutoFocusTerminal: boolean;
  tab: PanelTab;
  terminalSession: TerminalSession | undefined;
}

interface RootComposeFilePreviewTabContentProps {
  currentProjectId: string;
  isPanelOpen: boolean;
  primaryHostId: string | null;
  projectSources: SidebarProject["sources"];
  projects: readonly SidebarProject[] | undefined;
  rootPanelEnvironmentId: string | null;
  rootPanelThreadId: string | null;
  rootProjectHostId: string | null;
  tab: Extract<
    PanelTab,
    { kind: "workspace-file-preview" | "host-file-preview" }
  >;
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
  onStartTerminal,
  primaryHostId,
  projectSources,
  projects,
  rootPanelEnvironmentId,
  rootPanelThreadId,
  rootProjectHostId,
  shouldAutoFocusNewTab,
  shouldAutoFocusTerminal,
  tab,
  terminalSession,
}: RootComposePanelTabContentProps) {
  switch (tab.kind) {
    case "terminal":
      return (
        <ThreadTerminalPanel
          autoFocus={tab.id === activeTabId && shouldAutoFocusTerminal}
          isPanelOpen={isPanelOpen}
          onAutoFocusHandled={onAutoFocusTerminalHandled}
          session={terminalSession}
        />
      );
    case "new-tab":
      return (
        <NewTabPage
          autoFocus={tab.id === activeTabId && shouldAutoFocusNewTab}
          projectId={isProjectless ? undefined : currentProjectId}
          environmentId={rootPanelEnvironmentId}
          hostId={rootProjectHostId}
          onAutoFocusHandled={onAutoFocusNewTabHandled}
          onSelect={(path) => {
            onActivateTab(tab.id);
            onSelectFileSearchResult(path);
          }}
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
      return (
        <RootComposeFilePreviewTabContent
          currentProjectId={currentProjectId}
          isPanelOpen={isPanelOpen}
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
  isPanelOpen,
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
  const { openInPreferredFileTarget } = useOpenTargets(
    tab.kind === "workspace-file-preview" && tab.environmentId === null
      ? projectPreviewHostId
      : (environment?.hostId ?? null),
  );
  const workspaceRootPath = environment?.path ?? null;
  const relativeFileRootPath =
    tab.kind === "workspace-file-preview"
      ? tab.environmentId === null
        ? projectPreviewRootPath
        : workspaceRootPath
      : null;
  const openRelativeFileInEditor = useMemo(
    () =>
      buildOpenInEditorHandler({
        rootPath: relativeFileRootPath,
        openInPreferredTarget: openInPreferredFileTarget,
      }),
    [openInPreferredFileTarget, relativeFileRootPath],
  );
  const hostFileLineNumber = getFilePreviewLineRangeStart({
    lineRange: tab.kind === "host-file-preview" ? tab.lineRange : null,
  });
  const openHostFileInEditor =
    tab.kind === "host-file-preview" && openInPreferredFileTarget
      ? (path: string) => {
          openInPreferredFileTarget({
            lineNumber: hostFileLineNumber,
            path,
          });
        }
      : undefined;
  const onOpenInEditor =
    tab.kind === "host-file-preview"
      ? openHostFileInEditor
      : openRelativeFileInEditor;

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
  }
}
