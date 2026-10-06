import { useCallback, useState, type ReactNode } from "react";
import {
  SidebarNavigationIcon as NavigationIcon,
  useSidebarNavigation,
  useSidebarNavigationSplit,
  type SidebarNavigationItem,
  type SidebarNavigationProps,
} from "@bb/plugin/app";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@bb/shared-ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
  SIDEBAR_HOVER_ACTIONS_FADE_CLASS,
  SIDEBAR_HOVER_ACTIONS_ROW_CLASS,
  SIDEBAR_MORE_ACTION_TRIGGER_CLASS,
} from "@bb/shared-ui/sidebar-row-classes";
import {
  SidebarMore,
  SidebarOverflowItem,
} from "./ui/SidebarVisibilityControls.js";
import { SplitPaneMiniMap } from "@bb/shared-ui/split-pane-mini-map";

type MenuSurface = "context" | "dropdown";

function RowMenuItems({
  item,
  surface,
  canOpenInSplit,
  disablePending,
  onDisable,
}: {
  item: SidebarNavigationItem;
  surface: MenuSurface;
  canOpenInSplit: boolean;
  disablePending: boolean;
  onDisable: () => void;
}) {
  const { actions } = useSidebarNavigation();
  const Item = surface === "context" ? ContextMenuItem : DropdownMenuItem;
  const Separator =
    surface === "context" ? ContextMenuSeparator : DropdownMenuSeparator;
  return (
    <>
      {canOpenInSplit ? (
        <>
          <Item
            onSelect={() => actions.activate(item.id, { openInSplit: true })}
          >
            <Icon name="Columns2" aria-hidden="true" />
            Open in split
          </Item>
          <Separator />
        </>
      ) : null}
      <Item disabled={disablePending} onSelect={onDisable}>
        <Icon name="Unavailable" aria-hidden="true" />
        Disable
      </Item>
    </>
  );
}

function NavigationRow({
  item,
  isCompactViewport,
}: {
  item: SidebarNavigationItem;
  isCompactViewport: boolean;
}) {
  const { activeItemId, actions, isShortcutModifierHeld } =
    useSidebarNavigation();
  const split = useSidebarNavigationSplit(item.id);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isContextMenuOpen, setIsContextMenuOpen] = useState(false);
  const isActionsOpen = isDropdownOpen || isContextMenuOpen;
  const [disablePending, setDisablePending] = useState(false);
  const isActive =
    item.id === activeItemId && item.action.kind !== "new-thread";
  const Accessory = item.Accessory;
  const onDisable = useCallback(() => {
    setDisablePending(true);
    actions
      .disablePlugin(item.id)
      .catch(() => {})
      .finally(() => setDisablePending(false));
  }, [actions, item.id]);
  const menuItems = (surface: MenuSurface): ReactNode => (
    <RowMenuItems
      item={item}
      surface={surface}
      canOpenInSplit={split.isAvailable && !isCompactViewport}
      disablePending={disablePending}
      onDisable={onDisable}
    />
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
          Accessory && "pr-18",
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
        onClick={(event) =>
          actions.activate(item.id, {
            openInSplit: event.metaKey || event.ctrlKey,
          })
        }
      >
        <NavigationIcon icon={item.icon} />
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {split.layout ? (
            <SplitPaneMiniMap
              slots={split.layout.panes}
              label={`${item.label} — open in split`}
            />
          ) : null}
          {shortcut ? <AppCommandShortcutPill shortcut={shortcut} /> : null}
        </span>
      </Button>
      {Accessory ? (
        <span
          data-plugin-nav-sidebar-accessory=""
          data-sidebar-hover-actions-open={isActionsOpen ? "true" : undefined}
          className={cn(
            SIDEBAR_HOVER_ACTIONS_FADE_CLASS,
            "pointer-events-none absolute right-1 top-1/2 block min-w-5 max-h-5 max-w-16 -translate-y-1/2 overflow-hidden text-xs text-ellipsis whitespace-nowrap text-center leading-5",
          )}
        >
          <Accessory />
        </span>
      ) : null}
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
              {menuItems("dropdown")}
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
        {menuItems("context")}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function OverflowItem({
  item,
  isCompactViewport,
  onClose,
}: {
  item: SidebarNavigationItem;
  isCompactViewport: boolean;
  onClose: () => void;
}) {
  const { actions } = useSidebarNavigation();
  const split = useSidebarNavigationSplit(item.id);
  const canSplit = split.isAvailable && !isCompactViewport && !item.isDisabled;
  return (
    <SidebarOverflowItem
      item={{
        id: item.id,
        title: item.label,
        icon: <NavigationIcon icon={item.icon} />,
        ...(item.isDisabled ? { disabled: true } : {}),
      }}
      onActivate={(event) =>
        actions.activate(item.id, {
          openInSplit: event.metaKey || event.ctrlKey,
        })
      }
      onClose={onClose}
      additionalActions={
        !isCompactViewport ? (
          <DropdownMenuItem
            className="cursor-pointer"
            disabled={!canSplit}
            onSelect={() => {
              onClose();
              actions.activate(item.id, { openInSplit: true });
            }}
          >
            <Icon name="Columns2" aria-hidden="true" />
            Open in split
          </DropdownMenuItem>
        ) : null
      }
    />
  );
}

export function Navigation({ isCompactViewport }: SidebarNavigationProps) {
  const { items } = useSidebarNavigation();
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
          <NavigationRow
            key={item.id}
            item={item}
            isCompactViewport={isCompactViewport}
          />
        ))}
        {hidden.length > 0 ? (
          <SidebarMore
            ariaLabel="More sidebar navigation"
            listLabel="More navigation"
          >
            {(close) =>
              hidden.map((item) => (
                <OverflowItem
                  key={item.id}
                  item={item}
                  isCompactViewport={isCompactViewport}
                  onClose={close}
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
