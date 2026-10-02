import { useContext, type ComponentProps, type ReactNode } from "react";
import { useAtom } from "jotai";
import type { Environment } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { COARSE_POINTER_COMPACT_ICON_SIZE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { EmptyStatePanel } from "@bb/shared-ui/empty-state";
import { Icon } from "@bb/shared-ui/icon";
import { Skeleton } from "@bb/shared-ui/skeleton";
import { cn } from "@bb/shared-ui/lib/utils";
import { useAppCommandShortcut } from "@/components/commands/AppCommandProvider";
import { PluginItemIcon } from "@/components/plugin/PluginIcon";
import {
  PluginPanelTabContent,
  usePluginPanelActions,
} from "@/components/plugin/PluginPanelActions";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import { useGitDiffTab } from "@/components/secondary-panel/git-diff/GitDiffTab";
import type { GitDiffTabStatus } from "@/components/secondary-panel/gitDiffTabEligibility";
import { NewTabPage } from "@/components/secondary-panel/NewTabPage";
import {
  GIT_DIFF_TAB_ID,
  THREAD_INFO_TAB_ID,
} from "@/components/secondary-panel/panelTabs";
import { RightPanelFileTabIcon } from "@/components/secondary-panel/RightPanelFileTabIcon";
import { SecondaryPanelHostLayoutContext } from "@/components/secondary-panel/SecondaryPanelHostLayoutContext";
import { SecondaryPanelLayout } from "@/components/secondary-panel/SecondaryPanelLayout";
import {
  ThreadMetadataCard,
  ThreadMetadataContent,
  hasAnyThreadMetadata,
  type ThreadMetadataContentProps,
} from "@/components/secondary-panel/ThreadMetadataContent";
import {
  ThreadSecondaryPanel,
  type SecondaryPanelFixedTab,
  type SecondaryPanelRenderableTab,
} from "@/components/secondary-panel/ThreadSecondaryPanel";
import {
  HostFilePreviewTabContent,
  WorkspaceFilePreviewTabContent,
} from "@/components/secondary-panel/ThreadSecondaryPanelTabContent";
import { getThreadConversationCollapsedAtom } from "@/components/secondary-panel/threadSecondaryPanelAtoms";
import type { ThreadPanelController } from "@/components/secondary-panel/useThreadPanel";
import { ThreadTerminalPanel } from "@/components/thread/terminal/ThreadTerminalPanel";
import type {
  ThreadTimelineLinkHandler,
  ThreadTimelineLocalFileLinkHandler,
} from "@/components/thread/timeline";
import { ThreadTimelineNavigationProvider } from "@/components/thread/timeline/ThreadTimelineNavigationContext";
import { DETAIL_GRID_CLASS } from "@/components/ui/detail-card.js";
import type { MarkdownLinkRouting } from "@/components/ui/markdown-link-routing";
import { useThreads } from "@/hooks/queries/thread-queries";
import {
  getAbsoluteDirname,
  isAbsoluteFilePathWithinRoot,
  resolveAbsoluteFilePath,
} from "@/lib/absolute-file-path";
import { usePluginSlots } from "@/plugins/registry";
import { ThreadTimelinePane } from "./ThreadTimelinePane";

type OpenFileInTarget = (request: {
  lineNumber: number | null;
  path: string;
}) => void;

interface ThreadRightPanelProps {
  panel: ThreadPanelController;
  metadata: ThreadMetadataContentProps;
  isMetadataLoading: boolean;
  environment: Environment | undefined;
  isFocused: boolean;
  canCreateTerminal: boolean;
  gitDiffTabStatus: GitDiffTabStatus;
  onRetryGitDiffEligibility: () => void;
  onOpenLink: ThreadTimelineLinkHandler;
  onOpenLocalFileLink: ThreadTimelineLocalFileLinkHandler;
  resolveMentionLink: PromptMentionLinkResolver;
  onOpenFileInEditor: ((relativePath: string) => void) | undefined;
  openInPreferredFileTarget: OpenFileInTarget | undefined;
}

interface ThreadDetailSecondaryContentProps extends ThreadRightPanelProps {
  footer: ReactNode;
  header: ReactNode;
  isBoundedPane: boolean;
  renderHostedPanel: (panel: ReactNode) => ReactNode;
  timeline: Omit<ComponentProps<typeof ThreadTimelinePane>, "footer">;
}

export function ThreadDetailSecondaryContent({
  footer,
  header,
  isBoundedPane,
  renderHostedPanel,
  timeline,
  ...panelProps
}: ThreadDetailSecondaryContentProps) {
  const { panel } = panelProps;
  const [isConversationCollapsed, setConversationCollapsed] = useAtom(
    getThreadConversationCollapsedAtom(timeline.threadId),
  );
  return (
    <div
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-clip",
        !isBoundedPane && "-mx-4 -mb-4 -mt-4 md:-mx-5 md:-mb-5 md:-mt-5",
      )}
    >
      <SecondaryPanelLayout
        open={panel.isOpen}
        onToggle={panel.toggle}
        panelGroupKey="thread-detail"
        resetKey={timeline.threadId}
        contentKey={timeline.threadId}
        mainPanelId="thread-detail-timeline-panel"
        mainHeader={header}
        main={<ThreadTimelinePane {...timeline} footer={footer} />}
        collapse={{
          active: isConversationCollapsed,
          onToggle: () => setConversationCollapsed((collapsed) => !collapsed),
        }}
        renderHostedPanel={renderHostedPanel}
        renderPanel={(layout) => (
          <ThreadRightPanel {...panelProps} {...layout} />
        )}
      />
    </div>
  );
}

function markdownLinkRouting(
  props: ThreadRightPanelProps,
  baseDir: string | undefined,
  rootPath: string | null,
): MarkdownLinkRouting {
  const { onOpenLink } = props;
  if (rootPath === null) return { onOpenLink };
  return {
    onOpenLink,
    localFile: {
      absoluteLinks: { kind: "contained", rootPath },
      onOpenLink: props.onOpenLocalFileLink,
      ...(baseDir === undefined
        ? {}
        : { relativeLinks: { baseDir, rootPath } }),
    },
  };
}

function ThreadRightPanel(
  props: ThreadRightPanelProps & {
    isMainCollapsed: boolean;
    onToggleMainCollapse: () => void;
    resizablePanelId?: string;
  },
) {
  const {
    panel,
    metadata,
    environment,
    canCreateTerminal,
    gitDiffTabStatus,
    onOpenLink,
    onOpenFileInEditor,
    openInPreferredFileTarget,
  } = props;
  const { thread, projectId } = metadata;
  const { tabs, isOpen } = panel;
  const hostLayout = useContext(SecondaryPanelHostLayoutContext);
  const diffShortcut = useAppCommandShortcut("diff.toggle");
  const { threadPanels } = usePluginSlots();
  const pluginActions = usePluginPanelActions({
    openPluginPanel: panel.openPluginPanel,
    threadId: thread.id,
  });
  const hasForks =
    (useThreads(
      {
        projectId: thread.projectId,
        sourceThreadId: thread.id,
        originKind: "fork",
        archived: false,
      },
      { enabled: isOpen },
    ).data?.length ?? 0) > 0;
  const workspaceRootPath = environment?.path ?? null;
  const openFilePreview = (path: string, replaceNewTab = false) =>
    panel.openWorkspaceFile(
      {
        lineRange: null,
        path,
        source: { kind: "working-tree" },
        statusLabel: null,
      },
      replaceNewTab,
    );
  const isGitDiffEligible = gitDiffTabStatus === "eligible";
  const diff = useGitDiffTab({
    environmentId: thread.environmentId ?? undefined,
    isActive:
      isGitDiffEligible &&
      tabs.activeTab === null &&
      tabs.activeTabId === GIT_DIFF_TAB_ID &&
      (hostLayout?.isOpen ?? isOpen) &&
      !hostLayout?.isSuppressed,
    requestedMergeBaseBranch: panel.requestedMergeBaseBranch,
    pendingCommitSha: panel.pendingGitDiffCommitSha,
    pendingScrollPath: panel.pendingGitDiffScrollPath,
    onClearPending: panel.clearPendingGitDiff,
    workspaceRootPath,
    onOpenFileInEditor,
    onOpenFilePreview: openFilePreview,
  });

  const fixedTabs: SecondaryPanelFixedTab[] = [
    {
      ariaLabel: "Show thread info panel",
      label: "Info",
      leadingVisual: <Icon name="Info" />,
      onSelect: () => tabs.activate(THREAD_INFO_TAB_ID),
      tab: { id: THREAD_INFO_TAB_ID },
      title: "Thread info",
      content: (
        <div className="flex min-h-0 flex-1 flex-col">
          {hasAnyThreadMetadata(metadata, hasForks) ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <ThreadMetadataContent {...metadata} />
            </div>
          ) : props.isMetadataLoading ? (
            <ThreadMetadataLoadingSkeleton />
          ) : (
            <div className="px-4 pt-1 text-sm text-muted-foreground">
              No thread details available.
            </div>
          )}
        </div>
      ),
    },
  ];
  if (gitDiffTabStatus !== "ineligible") {
    fixedTabs.push({
      ariaLabel: "Show diff panel",
      label: "Diff",
      leadingVisual: <Icon name="FileDiff" />,
      onSelect: () => tabs.activate(GIT_DIFF_TAB_ID),
      shortcut: diffShortcut,
      tab: { id: GIT_DIFF_TAB_ID },
      title: "Diff",
      toolbar: isGitDiffEligible ? diff.toolbar : undefined,
      content: isGitDiffEligible ? (
        diff.content
      ) : (
        <EmptyStatePanel className="m-4 rounded-lg" role="status">
          {gitDiffTabStatus === "error" ? (
            <div className="flex flex-col items-center gap-3 text-center">
              <span>Could not determine whether this workspace uses Git.</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={props.onRetryGitDiffEligibility}
              >
                Retry
              </Button>
            </div>
          ) : (
            "Checking Git support…"
          )}
        </EmptyStatePanel>
      ),
    });
  }

  const fileName = (path: string) => path.split("/").at(-1) ?? path;
  const panelTabs = tabs.state.tabs.map((tab): SecondaryPanelRenderableTab => {
    const shared = {
      tab,
      statusLabel: null,
      onClose: () => tabs.close(tab.id),
      onSelect: () => tabs.activate(tab.id),
    };
    switch (tab.kind) {
      case "terminal": {
        const session = panel.terminalSessions?.find(
          (item) => item.id === tab.terminalId,
        );
        return {
          ...shared,
          label: session?.title ?? "Terminal",
          leadingVisual: (
            <Icon
              name="Terminal"
              className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
              aria-hidden
            />
          ),
          statusLabel:
            session === undefined || session.status === "running"
              ? null
              : session.status,
          onSelect: () => {
            panel.setFocusRequest("terminal");
            tabs.activate(tab.id);
          },
          onClose: () => panel.closeTerminal(tab.terminalId),
          renderContent: () => (
            <ThreadTerminalPanel
              autoFocus={panel.focusRequest === "terminal"}
              isPanelOpen={isOpen}
              onAutoFocusHandled={() => panel.setFocusRequest(null)}
              onOpenLink={onOpenLink}
              session={session}
            />
          ),
        };
      }
      case "new-tab":
        return {
          ...shared,
          label: "New tab",
          leadingVisual: (
            <Icon
              name="NewTab"
              className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
              aria-hidden
            />
          ),
          renderContent: () => (
            <NewTabPage
              autoFocus={panel.focusRequest === "new-tab"}
              projectId={projectId}
              environmentId={thread.environmentId ?? null}
              onAutoFocusHandled={() => panel.setFocusRequest(null)}
              onSelect={(path) => openFilePreview(path, true)}
              onStartTerminal={
                canCreateTerminal ? panel.startTerminal : undefined
              }
              pluginActions={pluginActions}
            />
          ),
        };
      case "workspace-file-preview": {
        const copyPath = resolveAbsoluteFilePath({
          path: tab.path,
          rootPath: workspaceRootPath,
        });
        return {
          ...shared,
          label: fileName(tab.path),
          leadingVisual: <RightPanelFileTabIcon path={tab.path} />,
          statusLabel: tab.statusLabel,
          renderContent: () => (
            <WorkspaceFilePreviewTabContent
              activePath={tab.path}
              copyPath={copyPath}
              environmentId={tab.environmentId ?? ""}
              isPanelOpen={isOpen}
              lineRange={tab.lineRange}
              markdownLinkRouting={markdownLinkRouting(
                props,
                copyPath ? getAbsoluteDirname({ path: copyPath }) : undefined,
                workspaceRootPath,
              )}
              onOpenInEditor={onOpenFileInEditor}
              source={tab.source}
              statusLabel={tab.statusLabel}
              threadId={thread.id}
            />
          ),
        };
      }
      case "host-file-preview": {
        const baseDir = getAbsoluteDirname({ path: tab.path });
        const isInWorkspace =
          baseDir !== undefined &&
          workspaceRootPath !== null &&
          isAbsoluteFilePathWithinRoot({
            candidatePath: baseDir,
            rootPath: workspaceRootPath,
          });
        return {
          ...shared,
          label: fileName(tab.path),
          leadingVisual: <RightPanelFileTabIcon path={tab.path} />,
          renderContent: () => (
            <HostFilePreviewTabContent
              activePath={tab.path}
              copyPath={tab.path}
              environmentId={tab.environmentId}
              isPanelOpen={isOpen}
              lineRange={tab.lineRange}
              markdownLinkRouting={markdownLinkRouting(
                props,
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
              threadId={thread.id}
            />
          ),
        };
      }
      case "plugin-panel": {
        const action = threadPanels.find(
          (item) => item.pluginId === tab.pluginId && item.id === tab.actionId,
        );
        return {
          ...shared,
          contentFillsRegion: action?.layout === "flush",
          label: tab.title,
          leadingVisual: (
            <PluginItemIcon
              pluginId={tab.pluginId}
              icon={action?.icon ?? null}
              className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
            />
          ),
          renderContent: () => (
            <ThreadTimelineNavigationProvider
              environmentId={thread.environmentId}
              onOpenLink={onOpenLink}
              onOpenLocalFileLink={props.onOpenLocalFileLink}
              resolveMentionLink={props.resolveMentionLink}
              threadId={thread.id}
              workspaceRootPath={environment?.path ?? undefined}
            >
              <PluginPanelTabContent
                tab={tab}
                context={{ kind: "thread", threadId: thread.id }}
              />
            </ThreadTimelineNavigationProvider>
          ),
        };
      }
    }
  });

  return (
    <ThreadSecondaryPanel
      activeTabId={tabs.activeTabId}
      canNavigateTabs={props.isFocused}
      tabs={panelTabs}
      fixedTabs={fixedTabs}
      isOpen={isOpen}
      onClose={panel.close}
      onOpenNewTab={panel.openNewTab}
      isConversationCollapsed={props.isMainCollapsed}
      onToggleConversationCollapse={props.onToggleMainCollapse}
      resizablePanelId={props.resizablePanelId}
    />
  );
}

function ThreadMetadataLoadingSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ThreadMetadataCard>
        {["w-40", "w-28", "w-36", "w-24"].map((valueWidth, index) => (
          <div
            key={index}
            className={cn(DETAIL_GRID_CLASS, "items-center py-0.5")}
          >
            <Skeleton className="h-3 w-14 rounded-sm" />
            <Skeleton className={`h-3 ${valueWidth} max-w-full rounded-sm`} />
          </div>
        ))}
      </ThreadMetadataCard>
    </div>
  );
}
