import { useState, type ReactNode } from "react";
import {
  SidebarNavigationIcon as NavigationIcon,
  useSidebarNavigation,
  type SidebarNavigationItem,
  type SidebarNavigationProps,
} from "@bb/plugin/app";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@bb/shared-ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { CompactViewportOverrideProvider } from "@bb/shared-ui/hooks/use-compact-viewport";
import { cn } from "@bb/shared-ui/lib/utils";
import { AppCommandShortcutPill } from "@bb/shared-ui/app-command-shortcut-pill";
import {
  PROJECT_LIST_ACTION_BUTTON_CLASS,
  SIDEBAR_CONTROL_STATE_CLASS,
  SIDEBAR_HOVER_ACTIONS_CLASS,
  SIDEBAR_HOVER_ACTIONS_ROW_CLASS,
  SIDEBAR_MORE_ACTION_TRIGGER_CLASS,
} from "@bb/shared-ui/sidebar-row-classes";
import {
  SidebarMore,
  SidebarOverflowItem,
} from "./ui/SidebarVisibilityControls.js";

function NavigationRow({ item }: { item: SidebarNavigationItem }) {
  const { activeItemId, actions, isShortcutModifierHeld } =
    useSidebarNavigation();
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isContextMenuOpen, setIsContextMenuOpen] = useState(false);
  const isActionsOpen = isDropdownOpen || isContextMenuOpen;
  const [disablePending, setDisablePending] = useState(false);
  const isActive =
    item.id === activeItemId && item.action.kind !== "new-thread";
  const disable = () => {
    setDisablePending(true);
    actions
      .disablePlugin(item.id)
      .catch(() => {})
      .finally(() => setDisablePending(false));
  };
  const disableItemContent: ReactNode = (
    <>
      <Icon name="Unavailable" aria-hidden="true" />
      Disable
    </>
  );
  const shortcut = isShortcutModifierHeld ? item.shortcut : null;
  const optionsLabel = `${item.label} panel options`;
  const hasMenu = item.pluginId !== null;
  const row = (
    <div
      className={cn(
        SIDEBAR_HOVER_ACTIONS_ROW_CLASS,
        "relative",
        !item.isLoading &&
          "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200",
      )}
      data-sidebar-navigation-item={item.id}
    >
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className={cn(
          PROJECT_LIST_ACTION_BUTTON_CLASS,
          "group/nav-row w-full",
          shortcut ? "pr-0" : "pr-7",
          (isActive || isContextMenuOpen) &&
            "bg-sidebar-accent text-sidebar-foreground",
          item.isLoading &&
            "text-sidebar-foreground/55 dark:text-sidebar-foreground/55 [&_[data-icon-root]]:opacity-60",
        )}
        disabled={item.isDisabled}
        aria-busy={item.isLoading || undefined}
        aria-current={isActive ? "page" : undefined}
        aria-keyshortcuts={item.shortcut?.ariaKeyShortcuts}
        aria-label={
          item.shortcut ? `${item.label} (${item.shortcut.label})` : undefined
        }
        onClick={() => actions.activate(item.id, { openInSplit: false })}
      >
        <NavigationIcon icon={item.icon} />
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {shortcut ? <AppCommandShortcutPill shortcut={shortcut} /> : null}
        </span>
      </Button>
      {hasMenu ? (
        <div
          data-sidebar-hover-actions-open={isActionsOpen ? "true" : undefined}
          data-sidebar-hover-actions-mobile="always"
          className={cn(
            SIDEBAR_HOVER_ACTIONS_CLASS,
            "absolute inset-y-0 right-0 flex items-center",
            shortcut && "hidden",
          )}
        >
          <DropdownMenu onOpenChange={setIsDropdownOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={optionsLabel}
                className={cn(
                  "rounded-md p-0",
                  SIDEBAR_MORE_ACTION_TRIGGER_CLASS,
                  SIDEBAR_CONTROL_STATE_CLASS,
                  isContextMenuOpen && "bg-state-active",
                )}
              >
                <Icon
                  name="MoreHorizontal"
                  className={COARSE_POINTER_ICON_SIZE_CLASS}
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={disablePending} onSelect={disable}>
                {disableItemContent}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}
    </div>
  );
  if (!hasMenu) return row;

  return (
    <ContextMenu onOpenChange={setIsContextMenuOpen}>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent aria-label={optionsLabel}>
        <ContextMenuItem disabled={disablePending} onSelect={disable}>
          {disableItemContent}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function Navigation({ isCompactViewport }: SidebarNavigationProps) {
  const { actions, items } = useSidebarNavigation();
  const visible = items.filter((item) => item.isVisible);
  const hidden = items.filter((item) => !item.isVisible);

  if (items.length === 0) return null;

  return (
    <CompactViewportOverrideProvider isCompactViewport={isCompactViewport}>
      <div
        className="relative shrink-0 space-y-0.5 px-2 py-2"
        data-testid="plugin-nav-sidebar-items"
      >
        {visible.map((item) => (
          <NavigationRow key={item.id} item={item} />
        ))}
        {hidden.length > 0 ? (
          <SidebarMore
            ariaLabel="More sidebar navigation"
            listLabel="More navigation"
          >
            {(close) =>
              hidden.map((item) => (
                <SidebarOverflowItem
                  key={item.id}
                  item={{
                    id: item.id,
                    title: item.label,
                    icon: <NavigationIcon icon={item.icon} />,
                    disabled: item.isDisabled,
                  }}
                  onActivate={() => {
                    close();
                    actions.activate(item.id, { openInSplit: false });
                  }}
                />
              ))
            }
          </SidebarMore>
        ) : null}
      </div>
      <div
        aria-hidden="true"
        className="mx-2 my-2 shrink-0 border-t border-sidebar-border/25"
        data-testid="navigation-divider"
      />
    </CompactViewportOverrideProvider>
  );
}
