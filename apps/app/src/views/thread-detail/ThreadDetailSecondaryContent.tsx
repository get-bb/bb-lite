import {
  useContext,
  useMemo,
  type ComponentProps,
  type ReactNode,
} from "react";
import { useAtom } from "jotai";
import { Button } from "@bb/shared-ui/button";
import { EmptyStatePanel } from "@bb/shared-ui/empty-state";
import { Icon } from "@bb/shared-ui/icon";
import { Skeleton } from "@bb/shared-ui/skeleton";
import { cn } from "@bb/shared-ui/lib/utils";
import { useAppCommandShortcut } from "@/components/commands/AppCommandProvider";
import { usePluginPanelActions } from "@/components/plugin/PluginPanelActions";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import { useGitDiffTab } from "@/components/secondary-panel/git-diff/GitDiffTab";
import {
  GIT_DIFF_TAB_ID,
  THREAD_INFO_TAB_ID,
} from "@/components/secondary-panel/panelTabs";
import { SecondaryPanelHostLayoutContext } from "@/components/secondary-panel/SecondaryPanelHostLayoutContext";
import { SidePanelHostContext } from "@/components/secondary-panel/SidePanelHostContext";
import {
  SidePanelTabBody,
  SidePanelTabIcon,
  findSidePanelTabKind,
  useSidePanelTabKinds,
} from "@/components/secondary-panel/SidePanelTabChrome";
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
import { getThreadConversationCollapsedAtom } from "@/components/secondary-panel/threadSecondaryPanelAtoms";
import type { ThreadPanelController } from "@/components/secondary-panel/useThreadPanel";
import { DETAIL_GRID_CLASS } from "@/components/ui/detail-card.js";
import { MarkdownLocalFileContextMenuContext } from "@/components/ui/markdown-link-routing";
import { useThreads } from "@/hooks/queries/thread-queries";
import { usePluginSlots } from "@/plugins/registry";
import { ThreadTimelinePane } from "./ThreadTimelinePane";

interface ThreadRightPanelProps {
  panel: ThreadPanelController;
  metadata: ThreadMetadataContentProps;
  isMetadataLoading: boolean;
  onRetryGitDiffEligibility: () => void;
  resolveMentionLink: PromptMentionLinkResolver;
}

interface ThreadDetailSecondaryContentProps extends ThreadRightPanelProps {
  footer: ReactNode;
  header: ReactNode;
  isBoundedPane: boolean;
  timeline: Omit<ComponentProps<typeof ThreadTimelinePane>, "footer">;
}

export function ThreadDetailSecondaryContent({
  footer,
  header,
  isBoundedPane,
  timeline,
  ...panelProps
}: ThreadDetailSecondaryContentProps) {
  const { panel } = panelProps;
  const [isConversationCollapsed, setConversationCollapsed] = useAtom(
    getThreadConversationCollapsedAtom(timeline.threadId),
  );
  const withFileContextMenu = (node: ReactNode) => (
    <MarkdownLocalFileContextMenuContext.Provider
      value={panel.localFileContextMenuItems}
    >
      {node}
    </MarkdownLocalFileContextMenuContext.Provider>
  );
  return withFileContextMenu(
    <div
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-clip",
        !isBoundedPane && "-mx-4 -mb-4 -mt-4 md:-mx-5 md:-mb-5 md:-mt-5",
      )}
    >
      <SecondaryPanelLayout
        open={panel.isOpen}
        onToggle={panel.toggle}
        onClose={panel.close}
        panelGroupKey="thread-detail"
        resetKey={timeline.threadId}
        contentKey={timeline.threadId}
        drawerLabel="Thread details"
        drawerFallback={<ThreadMetadataLoadingSkeleton />}
        mainPanelId="thread-detail-timeline-panel"
        mainHeader={header}
        main={<ThreadTimelinePane {...timeline} footer={footer} />}
        collapse={{
          active: isConversationCollapsed,
          onToggle: () => setConversationCollapsed((collapsed) => !collapsed),
        }}
        renderHostedPanel={withFileContextMenu}
        renderPanel={(layout) => (
          <ThreadRightPanel {...panelProps} {...layout} />
        )}
      />
    </div>,
  );
}

function ThreadRightPanel(
  props: ThreadRightPanelProps & {
    presentation: "inline" | "drawer";
    isMainCollapsed: boolean;
    onToggleMainCollapse: () => void;
    resizablePanelId?: string;
  },
) {
  const { panel, metadata } = props;
  const { thread, projectId } = metadata;
  const { tabs, isOpen, gitDiffTabStatus } = panel;
  const hostLayout = useContext(SecondaryPanelHostLayoutContext);
  const diffShortcut = useAppCommandShortcut("diff.toggle");
  const { threadPanels } = usePluginSlots();
  const kinds = useSidePanelTabKinds();
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
  const workspaceRootPath = metadata.environment?.path ?? null;
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
    onOpenFileInEditor: panel.openFileInEditor,
    onOpenFilePreview: panel.previewWorkspaceFile,
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

  const host = useMemo(
    () => ({
      panel,
      pluginActions,
      resolveMentionLink: props.resolveMentionLink,
    }),
    [panel, pluginActions, props.resolveMentionLink],
  );
  const panelTabs = tabs.state.tabs.map((tab): SecondaryPanelRenderableTab => {
    const kind = findSidePanelTabKind(kinds, tab.kind);
    const session =
      tab.kind === "terminal"
        ? panel.terminalSessions?.find((item) => item.id === tab.terminalId)
        : undefined;
    const action =
      tab.kind === "plugin-panel"
        ? threadPanels.find(
            (item) =>
              item.pluginId === tab.pluginId && item.id === tab.actionId,
          )
        : undefined;
    return {
      tab,
      contentFillsRegion: action?.layout === "flush",
      label: session?.title ?? kind?.title?.(tab) ?? tab.kind,
      leadingVisual: <SidePanelTabIcon tab={tab} />,
      statusLabel:
        tab.kind === "terminal"
          ? session === undefined || session.status === "running"
            ? null
            : session.status
          : tab.kind === "workspace-file-preview"
            ? tab.statusLabel
            : null,
      onSelect: () => {
        if (tab.kind === "terminal") panel.setFocusRequest("terminal");
        tabs.activate(tab.id);
      },
      onClose: () =>
        tab.kind === "terminal"
          ? panel.closeTerminal(tab.terminalId)
          : tabs.close(tab.id),
      renderContent: () => (
        <SidePanelHostContext.Provider value={host}>
          <SidePanelTabBody
            tab={tab}
            threadId={thread.id}
            projectId={projectId}
            environmentId={thread.environmentId ?? null}
            workspaceRootPath={workspaceRootPath}
            isPanelOpen={isOpen}
          />
        </SidePanelHostContext.Provider>
      ),
    };
  });

  return (
    <ThreadSecondaryPanel
      activeTabId={tabs.activeTabId}
      canNavigateTabs={panel.isFocused}
      tabs={panelTabs}
      fixedTabs={fixedTabs}
      isOpen={isOpen}
      onClose={panel.close}
      onOpenNewTab={panel.openNewTab}
      isConversationCollapsed={
        props.presentation === "inline" && props.isMainCollapsed
      }
      onToggleConversationCollapse={props.onToggleMainCollapse}
      renderAsDrawer={props.presentation === "drawer"}
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
