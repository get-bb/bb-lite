import type { ComponentProps, ReactNode } from "react";
import { Skeleton } from "@bb/shared-ui/skeleton";
import { cn } from "@bb/shared-ui/lib/utils";
import { PluginHomepageSections } from "@/components/plugin/PluginHomepageSections";
import { usePluginComposerHost } from "@/components/plugin/plugin-composer-host";
import { SecondaryPanelLayout } from "@/components/secondary-panel/SecondaryPanelLayout";
import { LazyThreadSecondaryPanel } from "@/components/secondary-panel/lazySecondaryPanelComponents";
import { PAGE_SHELL_CONTENT_STYLE } from "@/components/ui/page-shell-content-style.js";
import { RootComposeCompactHome } from "./RootComposeCompactHome";

const ROOT_COMPOSE_MAX_WIDTH_CLASS = "max-w-[760px]";

export const ROOT_COMPOSE_PINNED_PANEL_TOGGLE_POSITION_CLASS =
  "right-[calc(1rem+env(safe-area-inset-right))] top-[calc(0.625rem+env(safe-area-inset-top))] max-md:pointer-coarse:top-[calc(0.375rem+env(safe-area-inset-top))]";

type RootSecondaryPanelProps = Omit<
  ComponentProps<typeof LazyThreadSecondaryPanel>,
  "isConversationCollapsed" | "onToggleConversationCollapse" | "renderAsDrawer"
>;

interface RootComposeSecondaryContentProps {
  children: ReactNode;
  compactScrollContent: ReactNode;
  isCompactHomeLayout: boolean;
  contentClassName?: string;
  isSecondaryPanelOpen: boolean;
  onToggleSecondaryPanel: () => void;
  secondaryPanel: RootSecondaryPanelProps;
}

function DrawerPanelLoadingSkeleton() {
  return (
    <div
      data-testid="drawer-panel-loading-skeleton"
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4"
    >
      <Skeleton className="h-8 w-40 rounded-md" />
      <Skeleton className="h-24 w-full rounded-md" />
      <Skeleton className="h-24 w-full rounded-md" />
    </div>
  );
}

export function RootComposeSecondaryContent({
  children,
  compactScrollContent,
  isCompactHomeLayout,
  contentClassName,
  isSecondaryPanelOpen,
  onToggleSecondaryPanel,
  secondaryPanel,
}: RootComposeSecondaryContentProps) {
  const composerHost = usePluginComposerHost();

  const mainContent = (
    <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      {isCompactHomeLayout ? (
        <div
          className="@container/page flex min-h-0 flex-1 flex-col"
          style={PAGE_SHELL_CONTENT_STYLE}
        >
          <RootComposeCompactHome composer={children}>
            {compactScrollContent}
            <PluginHomepageSections />
          </RootComposeCompactHome>
        </div>
      ) : (
        <div className="@container/page min-h-0 flex-1 overflow-y-auto">
          <div
            className={cn(
              "mx-auto flex w-full flex-col px-4 pb-4 pt-2",
              ROOT_COMPOSE_MAX_WIDTH_CLASS,
              contentClassName,
            )}
            style={PAGE_SHELL_CONTENT_STYLE}
          >
            {children}
            {compactScrollContent}
            <PluginHomepageSections />
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="-mx-4 -mb-4 -mt-4 flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-clip md:-mx-5 md:-mb-5 md:-mt-5">
      <SecondaryPanelLayout
        open={isSecondaryPanelOpen}
        onToggle={onToggleSecondaryPanel}
        onClose={secondaryPanel.onClose}
        resetKey="new-thread"
        contentKey="new-thread"
        drawerLabel="Right panel"
        drawerFallback={<DrawerPanelLoadingSkeleton />}
        mainPanelId="root-compose-main-panel"
        main={mainContent}
        composerHost={composerHost}
        renderPanel={({
          presentation,
          onToggleMainCollapse,
          resizablePanelId,
        }) => (
          <LazyThreadSecondaryPanel
            {...secondaryPanel}
            renderAsDrawer={presentation === "drawer"}
            isConversationCollapsed={false}
            onToggleConversationCollapse={onToggleMainCollapse}
            resizablePanelId={resizablePanelId}
          />
        )}
      />
    </div>
  );
}
