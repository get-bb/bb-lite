import { useMemo } from "react";
import { cn } from "@bb/shared-ui/lib/utils";
import type { SidebarVisibilityItem } from "./SidebarVisibilityControls";
import { SidebarVisibilityCustomize } from "./SidebarVisibilityCustomize";
import {
  SidebarNavigationIcon,
  useSidebarNavigationModel,
} from "./SidebarNavigationModel";

export function SidebarNavigationCustomize({
  onClose,
}: {
  onClose: (restoreFocus: boolean) => void;
}) {
  const model = useSidebarNavigationModel();
  const items = useMemo<SidebarVisibilityItem[]>(
    () =>
      (model?.state.items ?? []).map((item) => ({
        id: item.id,
        title: item.label,
        icon: <SidebarNavigationIcon icon={item.icon} />,
        ...(item.isDisabled ? { disabled: true } : {}),
      })),
    [model?.state.items],
  );
  if (model === null) return null;
  const { arrangement, state } = model;
  return (
    <div
      className={cn("px-2 py-2", "shrink-0")}
      data-testid="plugin-nav-sidebar-items"
      data-sidebar-navigation-customize-mode="true"
    >
      <SidebarVisibilityCustomize
        title="Customize sidebar"
        listLabel="Sidebar navigation"
        items={items}
        visibleIds={arrangement.visibleKeys}
        onActivate={(item, event) =>
          state.actions.activate(item.id, {
            openInSplit: event.metaKey || event.ctrlKey,
          })
        }
        onDone={() => onClose(true)}
        onExit={() => onClose(false)}
        onReorder={arrangement.moveAny}
        onVisibleChange={arrangement.setVisible}
      />
    </div>
  );
}
