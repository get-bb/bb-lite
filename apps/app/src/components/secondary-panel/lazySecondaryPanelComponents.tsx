import { lazy, Suspense, useState, type ComponentProps } from "react";
import { Panel } from "react-resizable-panels";
import { Skeleton } from "@bb/shared-ui/skeleton";
import { cn } from "@bb/shared-ui/lib/utils";
import { PANEL_COLLAPSE_TRANSITION_CLASS } from "./panelTransitionTokens";
import { useSecondaryPanelMinimum } from "./secondaryPanelSizing";
import { ThreadSecondaryPanel } from "./ThreadSecondaryPanel";

type ThreadTerminalPanelModule =
  typeof import("@/components/thread/terminal/ThreadTerminalPanel");

function SecondaryPanelContentSkeleton() {
  return (
    <div
      className="space-y-2 px-4 py-4"
      data-testid="secondary-panel-content-skeleton"
    >
      <Skeleton className="h-3 w-3/4 rounded-sm" />
      <Skeleton className="h-3 w-full rounded-sm" />
      <Skeleton className="h-3 w-5/6 rounded-sm" />
      <Skeleton className="h-3 w-2/3 rounded-sm" />
    </div>
  );
}

function ThreadSecondaryPanelClosedPlaceholder({
  isConversationCollapsed,
  resizablePanelId,
}: {
  isConversationCollapsed: boolean;
  resizablePanelId: string | undefined;
}) {
  const minimumSize = useSecondaryPanelMinimum();
  return (
    <Panel
      id={resizablePanelId}
      collapsible
      collapsedSize={0}
      defaultSize={0}
      minSize={(1 - minimumSize.max) * 100}
      maxSize={isConversationCollapsed ? 100 : (1 - minimumSize.min) * 100}
      order={2}
      className={cn(
        "min-w-0 overflow-clip",
        `relative transition-[flex-grow,flex-basis] ${PANEL_COLLAPSE_TRANSITION_CLASS}`,
      )}
      data-testid="thread-secondary-panel-placeholder"
    />
  );
}

function useRetainedRealization(active: boolean): boolean {
  const [realized, setRealized] = useState(active);
  if (active && !realized) setRealized(true);
  return active || realized;
}

export function LazyThreadSecondaryPanel(
  props: ComponentProps<typeof ThreadSecondaryPanel>,
) {
  const realized = useRetainedRealization(props.isOpen);
  if (!realized) {
    return props.renderAsDrawer ? null : (
      <ThreadSecondaryPanelClosedPlaceholder
        isConversationCollapsed={props.isConversationCollapsed}
        resizablePanelId={props.resizablePanelId}
      />
    );
  }
  return <ThreadSecondaryPanel {...props} />;
}

const ThreadTerminalPanel = lazy(() =>
  import("@/components/thread/terminal/ThreadTerminalPanel").then((module) => ({
    default: module.ThreadTerminalPanel,
  })),
);

export function LazyThreadTerminalPanel(
  props: ComponentProps<ThreadTerminalPanelModule["ThreadTerminalPanel"]>,
) {
  return (
    <Suspense
      fallback={
        <div role="status" aria-label="Loading terminal">
          <SecondaryPanelContentSkeleton />
        </div>
      }
    >
      <ThreadTerminalPanel {...props} />
    </Suspense>
  );
}
