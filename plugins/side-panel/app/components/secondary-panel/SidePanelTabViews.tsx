import type { SidePanelTabProps } from "@bb/plugin/app";
import { PluginPanelTabContent } from "../plugin/PluginPanelActions";
import { ThreadTerminalPanel } from "bb-plugin-thread-view/contract";
import { ThreadTimelineNavigationProvider } from "@bb/app-kit/components/thread/timeline/ThreadTimelineNavigationContext";
import type { MarkdownLinkRouting } from "@bb/app-kit/components/ui/markdown-link-routing";
import {
  getAbsoluteDirname,
  isAbsoluteFilePathWithinRoot,
  resolveAbsoluteFilePath,
} from "@bb/app-kit/lib/absolute-file-path";
import { NewTabPage } from "./NewTabPage";
import { useSidePanelHost } from "./SidePanelHostContext";
import {
  HostFilePreviewTabContent,
  WorkspaceFilePreviewTabContent,
} from "./ThreadSecondaryPanelTabContent";
import { openThreadLink, type ThreadPanelController } from "./useThreadPanel";

function markdownLinkRouting(
  panel: ThreadPanelController,
  baseDir: string | undefined,
  rootPath: string | null,
): MarkdownLinkRouting {
  const onOpenLink = openThreadLink;
  if (rootPath === null) return { onOpenLink };
  return {
    onOpenLink,
    localFile: {
      absoluteLinks: { kind: "contained", rootPath },
      onOpenLink: panel.openLocalFileLink,
      ...(baseDir === undefined
        ? {}
        : { relativeLinks: { baseDir, rootPath } }),
    },
  };
}

export function TerminalTabView({ tab, isPanelOpen }: SidePanelTabProps) {
  const { panel } = useSidePanelHost();
  if (tab.kind !== "terminal") return null;
  return (
    <ThreadTerminalPanel
      autoFocus={panel.focusRequest === "terminal"}
      isPanelOpen={isPanelOpen}
      onAutoFocusHandled={() => panel.setFocusRequest(null)}
      onOpenLink={openThreadLink}
      session={panel.terminalSessions?.find(
        (item) => item.id === tab.terminalId,
      )}
    />
  );
}

export function NewTabView({ projectId, environmentId }: SidePanelTabProps) {
  const { panel, pluginActions } = useSidePanelHost();
  return (
    <NewTabPage
      autoFocus={panel.focusRequest === "new-tab"}
      projectId={projectId}
      environmentId={environmentId}
      onAutoFocusHandled={() => panel.setFocusRequest(null)}
      onSelect={(path) => panel.previewWorkspaceFile(path, true)}
      onStartTerminal={
        panel.canCreateTerminal ? panel.startTerminal : undefined
      }
      pluginActions={pluginActions}
    />
  );
}

export function WorkspaceFilePreviewTabView({
  tab,
  threadId,
  workspaceRootPath,
  isPanelOpen,
}: SidePanelTabProps) {
  const { panel } = useSidePanelHost();
  if (tab.kind !== "workspace-file-preview") return null;
  const copyPath = resolveAbsoluteFilePath({
    path: tab.path,
    rootPath: workspaceRootPath,
  });
  return (
    <WorkspaceFilePreviewTabContent
      activePath={tab.path}
      copyPath={copyPath}
      environmentId={tab.environmentId ?? ""}
      isPanelOpen={isPanelOpen}
      lineRange={tab.lineRange}
      markdownLinkRouting={markdownLinkRouting(
        panel,
        copyPath ? getAbsoluteDirname({ path: copyPath }) : undefined,
        workspaceRootPath,
      )}
      onOpenInEditor={panel.openFileInEditor}
      source={tab.source}
      statusLabel={tab.statusLabel}
      threadId={threadId}
    />
  );
}

export function HostFilePreviewTabView({
  tab,
  threadId,
  workspaceRootPath,
  isPanelOpen,
}: SidePanelTabProps) {
  const { panel } = useSidePanelHost();
  if (tab.kind !== "host-file-preview") return null;
  const { openInPreferredFileTarget } = panel;
  const baseDir = getAbsoluteDirname({ path: tab.path });
  const isInWorkspace =
    baseDir !== undefined &&
    workspaceRootPath !== null &&
    isAbsoluteFilePathWithinRoot({
      candidatePath: baseDir,
      rootPath: workspaceRootPath,
    });
  return (
    <HostFilePreviewTabContent
      activePath={tab.path}
      copyPath={tab.path}
      environmentId={tab.environmentId}
      isPanelOpen={isPanelOpen}
      lineRange={tab.lineRange}
      markdownLinkRouting={markdownLinkRouting(
        panel,
        baseDir,
        isInWorkspace ? workspaceRootPath : null,
      )}
      onOpenInEditor={
        openInPreferredFileTarget &&
        ((path) =>
          openInPreferredFileTarget({
            lineNumber: tab.lineRange?.startLineNumber ?? null,
            path,
          }))
      }
      threadId={threadId}
    />
  );
}

export function PluginPanelTabView({
  tab,
  threadId,
  environmentId,
  workspaceRootPath,
}: SidePanelTabProps) {
  const { panel, resolveMentionLink } = useSidePanelHost();
  if (tab.kind !== "plugin-panel") return null;
  return (
    <ThreadTimelineNavigationProvider
      environmentId={environmentId}
      onOpenLink={openThreadLink}
      onOpenLocalFileLink={panel.openLocalFileLink}
      resolveMentionLink={resolveMentionLink}
      threadId={threadId}
      workspaceRootPath={workspaceRootPath ?? undefined}
    >
      <PluginPanelTabContent tab={tab} context={{ kind: "thread", threadId }} />
    </ThreadTimelineNavigationProvider>
  );
}
