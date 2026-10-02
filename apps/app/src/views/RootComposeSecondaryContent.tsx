import type { ComponentProps, ReactNode } from "react";
import { cn } from "@bb/shared-ui/lib/utils";
import { SecondaryPanelLayout } from "@/components/secondary-panel/SecondaryPanelLayout";
import { LazyThreadSecondaryPanel } from "@/components/secondary-panel/lazySecondaryPanelComponents";
import { PAGE_SHELL_CONTENT_STYLE } from "@/components/ui/page-shell-content-style.js";

const ROOT_COMPOSE_MAX_WIDTH_CLASS = "max-w-[760px]";

export const ROOT_COMPOSE_PINNED_PANEL_TOGGLE_POSITION_CLASS =
  "right-4 top-2.5";

type RootSecondaryPanelProps = Omit<
  ComponentProps<typeof LazyThreadSecondaryPanel>,
  "isConversationCollapsed" | "onToggleConversationCollapse"
>;

interface RootComposeSecondaryContentProps {
  children: ReactNode;
  contentClassName?: string;
  isSecondaryPanelOpen: boolean;
  onToggleSecondaryPanel: () => void;
  secondaryPanel: RootSecondaryPanelProps;
}

export function RootComposeSecondaryContent({
  children,
  contentClassName,
  isSecondaryPanelOpen,
  onToggleSecondaryPanel,
  secondaryPanel,
}: RootComposeSecondaryContentProps) {
  const mainContent = (
    <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
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
        </div>
      </div>
    </div>
  );

  return (
    <div className="-mx-4 -mb-4 -mt-4 flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-clip md:-mx-5 md:-mb-5 md:-mt-5">
      <SecondaryPanelLayout
        open={isSecondaryPanelOpen}
        onToggle={onToggleSecondaryPanel}
        resetKey="new-thread"
        contentKey="new-thread"
        mainPanelId="root-compose-main-panel"
        main={mainContent}
        renderPanel={({ onToggleMainCollapse, resizablePanelId }) => (
          <LazyThreadSecondaryPanel
            {...secondaryPanel}
            isConversationCollapsed={false}
            onToggleConversationCollapse={onToggleMainCollapse}
            resizablePanelId={resizablePanelId}
          />
        )}
      />
    </div>
  );
}
