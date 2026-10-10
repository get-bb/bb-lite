import { useEffect, useRef } from "react";
import { useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { ProviderInfo, ThreadListEntry } from "@bb/domain";
import {
  getThreadListIndicatorLabel,
  resolveThreadListIndicator,
  threadListIndicatorStateForThread,
  type ThreadListIndicatorState,
} from "@bb/client-core";
import { resolveEnvironmentDisplayName } from "@bb/core-ui";
import { CHROME_SECTION_LABEL_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import {
  COARSE_POINTER_ICON_SIZE_CLASS,
  COARSE_POINTER_TEXT_BASE_CLASS,
  COARSE_POINTER_TEXT_SM_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { getSidebarThreadRowPaddingLeft } from "@bb/shared-ui/sidebar-row-classes";
import { ThreadStatusGlyph } from "@bb/shared-ui/thread-status-glyph";
import { ProviderIcon } from "@bb/app-kit/components/plugin/ProviderIcon";
import {
  ThreadTitle,
  useThreadTitleDisplayText,
} from "@bb/app-kit/components/thread/ThreadTitleMentions";
import { RouteAnchor } from "@bb/app-kit/components/ui/app-route-anchor";
import { OverflowFade } from "@bb/app-kit/components/ui/overflow-fade";
import { useSystemEnvironmentProviders } from "@bb/app-kit/hooks/queries/environment-provider-queries";
import { useSidebarNavigation } from "@bb/app-kit/hooks/queries/sidebar-navigation-query";
import { useSystemProviders } from "@bb/app-kit/hooks/queries/system-queries";
import { usePromptDraftInputThreadIds } from "../hooks/usePromptDraftStorage";
import {
  findEnvironmentDisplayProvider,
  getEnvironmentLabelIconName,
} from "@bb/app-kit/lib/environment-workspace-display";
import { formatRelativeTime } from "@bb/app-kit/lib/relative-time";
import {
  getThreadRoutePath,
  isProjectlessProjectId,
} from "@bb/app-kit/lib/route-paths";
import { getThreadDisplayTitle } from "@bb/app-kit/lib/thread-title";

export const MOBILE_RECENT_ROW_HEIGHT_PX = 60;
export const MOBILE_RECENT_LABEL_HEIGHT_PX = 24;

const MOBILE_RECENT_ROW_HEIGHT_CLASS = "h-15";
const NO_THREADS: readonly ThreadListEntry[] = [];

const collapsedThreadIdsAtom = atomWithStorage<string[]>(
  "bb.root-compose.collapsed-recent-threads",
  [],
);

interface MobileRecentNode {
  thread: ThreadListEntry;
  depth: number;
  children: MobileRecentNode[];
}

interface MobileRecentThreadRow {
  thread: ThreadListEntry;
  depth: number;
  indicatorState: ThreadListIndicatorState;
  hasChildren: boolean;
  isCollapsed: boolean;
}

function compareMobileRecentNodes(
  { thread: left }: MobileRecentNode,
  { thread: right }: MobileRecentNode,
): number {
  return (
    right.latestAttentionAt - left.latestAttentionAt ||
    right.createdAt - left.createdAt ||
    left.id.localeCompare(right.id)
  );
}

function buildMobileRecentNodes(
  allThreads: readonly ThreadListEntry[],
): MobileRecentNode[] {
  const threads = allThreads.filter((thread) => thread.visibility !== "hidden");
  const threadIds = new Set(threads.map((thread) => thread.id));
  const childrenByParentId = new Map<string, ThreadListEntry[]>();
  for (const thread of threads) {
    const parentId = thread.parentThreadId;
    if (parentId === null || !threadIds.has(parentId)) continue;
    const children = childrenByParentId.get(parentId);
    if (children) {
      children.push(thread);
    } else {
      childrenByParentId.set(parentId, [thread]);
    }
  }
  const visitedThreadIds = new Set<string>();
  const buildNode = (
    thread: ThreadListEntry,
    depth: number,
    ancestorThreadIds: ReadonlySet<string>,
  ): MobileRecentNode => {
    visitedThreadIds.add(thread.id);
    const lineage = new Set(ancestorThreadIds).add(thread.id);
    const children: MobileRecentNode[] = [];
    for (const child of childrenByParentId.get(thread.id) ?? []) {
      if (lineage.has(child.id) || visitedThreadIds.has(child.id)) continue;
      children.push(buildNode(child, depth + 1, lineage));
    }
    return { thread, depth, children: children.sort(compareMobileRecentNodes) };
  };
  const rootNodes: MobileRecentNode[] = [];
  for (const thread of threads) {
    const isRoot =
      thread.parentThreadId === null || !threadIds.has(thread.parentThreadId);
    if (isRoot && !visitedThreadIds.has(thread.id)) {
      rootNodes.push(buildNode(thread, 0, new Set()));
    }
  }
  for (const thread of threads) {
    if (!visitedThreadIds.has(thread.id)) {
      rootNodes.push(buildNode(thread, 0, new Set()));
    }
  }
  return rootNodes.sort(compareMobileRecentNodes);
}

function descendantThreads(node: MobileRecentNode): ThreadListEntry[] {
  return node.children.flatMap((child) => [
    child.thread,
    ...descendantThreads(child),
  ]);
}

function flattenMobileRecentNodes(
  nodes: readonly MobileRecentNode[],
  collapsedThreadIds: ReadonlySet<string>,
  draftThreadIds: ReadonlySet<string>,
  rows: MobileRecentThreadRow[],
): MobileRecentThreadRow[] {
  for (const node of nodes) {
    const { thread } = node;
    const hasChildren = node.children.length > 0;
    const isCollapsed = hasChildren && collapsedThreadIds.has(thread.id);
    let indicatorState = threadListIndicatorStateForThread(
      thread,
      draftThreadIds.has(thread.id),
    );
    if (isCollapsed) {
      for (const hidden of descendantThreads(node)) {
        const child = threadListIndicatorStateForThread(
          hidden,
          draftThreadIds.has(hidden.id),
        );
        indicatorState = {
          hasPendingInteraction:
            indicatorState.hasPendingInteraction || child.hasPendingInteraction,
          hasUnsubmittedDraft:
            indicatorState.hasUnsubmittedDraft || child.hasUnsubmittedDraft,
          hasUnreadError: indicatorState.hasUnreadError || child.hasUnreadError,
          hasUnreadSuccess:
            indicatorState.hasUnreadSuccess || child.hasUnreadSuccess,
          isBackgroundAgentActive:
            indicatorState.isBackgroundAgentActive ||
            child.isBackgroundAgentActive,
          isBackgroundCommandActive:
            indicatorState.isBackgroundCommandActive ||
            child.isBackgroundCommandActive,
          isGoalActive: indicatorState.isGoalActive || child.isGoalActive,
          queuedWork: indicatorState.queuedWork,
          isRuntimeActive:
            indicatorState.isRuntimeActive || child.isRuntimeActive,
          isWorkflowActive:
            indicatorState.isWorkflowActive || child.isWorkflowActive,
        };
      }
    }
    rows.push({
      thread,
      depth: node.depth,
      indicatorState,
      hasChildren,
      isCollapsed,
    });
    if (hasChildren && !isCollapsed) {
      flattenMobileRecentNodes(
        node.children,
        collapsedThreadIds,
        draftThreadIds,
        rows,
      );
    }
  }
  return rows;
}

function getMobileRecentAncestorIds(
  threadId: string,
  threads: readonly ThreadListEntry[],
): string[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const selected = byId.get(threadId);
  if (selected === undefined || selected.visibility === "hidden") return [];
  const ancestorIds: string[] = [];
  let parentThreadId = selected.parentThreadId;
  while (parentThreadId !== null && ancestorIds.length < byId.size) {
    const parent = byId.get(parentThreadId);
    if (parent === undefined) break;
    ancestorIds.push(parent.id);
    parentThreadId = parent.parentThreadId;
  }
  return ancestorIds;
}

function repeatsProjectName(
  workspaceName: string,
  projectName: string | null,
): boolean {
  return (
    projectName !== null &&
    (workspaceName === projectName ||
      workspaceName.startsWith(`${projectName} `))
  );
}

function MobileRecentThreadRow({
  highlighted,
  onToggleCollapsed,
  projectName,
  provider,
  row: { thread, depth, indicatorState, hasChildren, isCollapsed },
}: {
  highlighted: boolean;
  onToggleCollapsed: (threadId: string) => void;
  projectName: string | null;
  provider: ProviderInfo | null;
  row: MobileRecentThreadRow;
}) {
  const touchStartedBeforeLink = useRef(false);
  const { providers: environmentProviders } = useSystemEnvironmentProviders();
  const threadTitle = useThreadTitleDisplayText(getThreadDisplayTitle(thread));
  const indicatorKind = resolveThreadListIndicator(indicatorState);
  const indicatorLabel = getThreadListIndicatorLabel(indicatorKind);
  const environmentProviderLookup = findEnvironmentDisplayProvider(
    environmentProviders,
    thread.environmentProviderId,
  );
  const workspaceName = resolveEnvironmentDisplayName(
    {
      name: thread.environmentName,
      branchName: thread.environmentBranchName,
      path: thread.environmentPath,
      environmentProviderId: thread.environmentProviderId,
    },
    environmentProviderLookup,
  );
  const metadataText = [
    projectName,
    workspaceName !== null && repeatsProjectName(workspaceName, projectName)
      ? null
      : workspaceName,
    formatRelativeTime({
      timestamp: thread.latestAttentionAt,
      now: Date.now(),
    }),
  ]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(" · ");
  const hasWorkspaceIcon =
    environmentProviderLookup.status === "loaded" &&
    environmentProviderLookup.provider !== null;
  const providerTile = (
    <span
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-md border border-border-seam bg-surface-raised",
        depth > 0 && "opacity-60",
      )}
    >
      <ProviderIcon
        provider={provider ?? { id: thread.providerId }}
        className="size-4"
      />
    </span>
  );
  return (
    <li
      onTouchStart={(event) => {
        const touch = event.touches[0];
        const link = event.currentTarget.querySelector("a");
        touchStartedBeforeLink.current =
          hasChildren &&
          touch !== undefined &&
          link !== null &&
          touch.clientX < link.getBoundingClientRect().left;
      }}
      style={{ paddingLeft: getSidebarThreadRowPaddingLeft(depth) }}
      className={cn(
        "flex items-center gap-2.5 rounded-md pr-2",
        MOBILE_RECENT_ROW_HEIGHT_CLASS,
        highlighted && "bg-surface-selected",
      )}
    >
      {hasChildren ? (
        <button
          type="button"
          aria-expanded={!isCollapsed}
          aria-label={
            isCollapsed
              ? `Show threads under ${threadTitle}`
              : `Hide threads under ${threadTitle}`
          }
          className="group relative -ml-6 flex h-11 w-13 shrink-0 cursor-pointer items-center rounded-md pl-6 outline-none"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onToggleCollapsed(thread.id);
          }}
        >
          <Icon
            name="ChevronRight"
            className={cn(
              "absolute left-2 size-3 text-subtle-foreground transition-transform duration-150 group-hover:text-muted-foreground group-focus-visible:text-muted-foreground",
              !isCollapsed && "rotate-90",
              depth > 0 && "opacity-60",
            )}
            aria-hidden="true"
          />
          {providerTile}
        </button>
      ) : (
        providerTile
      )}
      <RouteAnchor
        href={getThreadRoutePath({
          projectId: thread.projectId,
          threadId: thread.id,
        })}
        aria-label={`Open ${threadTitle}${indicatorLabel ? ` — ${indicatorLabel}` : ""}`}
        onClick={(event) => {
          const ignoreTouchClick = touchStartedBeforeLink.current;
          touchStartedBeforeLink.current = false;
          if (event.detail > 0 && ignoreTouchClick) {
            event.preventDefault();
          }
        }}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          MOBILE_RECENT_ROW_HEIGHT_CLASS,
        )}
      >
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <ThreadTitle
              title={getThreadDisplayTitle(thread)}
              className={cn("font-medium", COARSE_POINTER_TEXT_BASE_CLASS)}
            />
          </span>
          <span
            className={cn(
              "flex min-w-0 items-center gap-1.5 leading-4 text-muted-foreground",
              COARSE_POINTER_TEXT_SM_CLASS,
            )}
            title={metadataText}
          >
            {hasWorkspaceIcon ? (
              <Icon
                name={getEnvironmentLabelIconName(environmentProviderLookup)}
                className="size-3.5 shrink-0"
                aria-hidden="true"
              />
            ) : null}
            <span className="min-w-0 truncate">{metadataText}</span>
          </span>
        </span>
        {indicatorKind !== "none" ? (
          <span className="flex size-6 shrink-0 items-center justify-center">
            <ThreadStatusGlyph {...indicatorState} />
          </span>
        ) : null}
      </RouteAnchor>
    </li>
  );
}

export function RootComposeMobileRecents({
  highlightedThreadId,
  showCreatingRow,
}: {
  highlightedThreadId: string | null;
  showCreatingRow: boolean;
}) {
  const sidebarNavigation = useSidebarNavigation().data;
  const systemProviders = useSystemProviders().data;
  const [collapsedThreadIdList, setCollapsedThreadIdList] = useAtom(
    collapsedThreadIdsAtom,
  );
  const projects = sidebarNavigation
    ? [sidebarNavigation.personalProject, ...sidebarNavigation.projects]
    : [];
  const threads = sidebarNavigation
    ? projects.flatMap((project) => project.threads)
    : NO_THREADS;
  const draftThreadIds = usePromptDraftInputThreadIds(threads);
  const ancestorIds =
    highlightedThreadId === null
      ? ""
      : getMobileRecentAncestorIds(highlightedThreadId, threads).join("\n");
  useEffect(() => {
    if (ancestorIds === "") return;
    const expanded = new Set(ancestorIds.split("\n"));
    setCollapsedThreadIdList((current) => {
      const next = current.filter((id) => !expanded.has(id));
      return next.length === current.length ? current : next;
    });
  }, [ancestorIds, setCollapsedThreadIdList]);
  const recentThreads = flattenMobileRecentNodes(
    buildMobileRecentNodes(threads),
    new Set(collapsedThreadIdList),
    draftThreadIds,
    [],
  );

  if (!showCreatingRow && recentThreads.length === 0) {
    return null;
  }

  return (
    <section
      data-root-compose-mobile-recents=""
      aria-labelledby="root-compose-mobile-recents"
      className="md:hidden"
    >
      <div className="sticky top-0 z-10 mb-1 bg-background px-2">
        <h2
          id="root-compose-mobile-recents"
          className={CHROME_SECTION_LABEL_CLASS}
        >
          Recent
        </h2>
        <OverflowFade placement="below" tone="background" size="sm" />
      </div>
      {showCreatingRow ? (
        <div
          role="status"
          className={cn(
            "flex items-center gap-2.5 rounded-md px-2 text-sm text-muted-foreground",
            MOBILE_RECENT_ROW_HEIGHT_CLASS,
          )}
        >
          <span className="min-w-0 flex-1 truncate">Creating thread</span>
          <span className="flex size-6 shrink-0 items-center justify-center">
            <Icon
              name="Loading"
              className={cn(
                "shrink-0 animate-spin text-muted-foreground/50",
                COARSE_POINTER_ICON_SIZE_CLASS,
              )}
              aria-hidden="true"
            />
          </span>
        </div>
      ) : null}
      {recentThreads.length > 0 ? (
        <ul className="space-y-px">
          {recentThreads.map((row) => (
            <MobileRecentThreadRow
              key={row.thread.id}
              highlighted={row.thread.id === highlightedThreadId}
              onToggleCollapsed={(threadId) =>
                setCollapsedThreadIdList((current) =>
                  current.includes(threadId)
                    ? current.filter((id) => id !== threadId)
                    : [...current, threadId],
                )
              }
              provider={
                systemProviders?.find(
                  (provider) => provider.id === row.thread.providerId,
                ) ?? null
              }
              projectName={
                isProjectlessProjectId(row.thread.projectId)
                  ? null
                  : (projects.find(
                      (project) => project.id === row.thread.projectId,
                    )?.name ?? null)
              }
              row={row}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
