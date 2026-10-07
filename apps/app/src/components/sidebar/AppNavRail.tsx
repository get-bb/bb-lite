import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type Ref,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { SidebarNavigationItem } from "@bb/plugin/app";
import { AppCommandShortcutPill } from "@bb/shared-ui/app-command-shortcut-pill";
import { Button } from "@bb/shared-ui/button";
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
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { PROJECT_LIST_ACTION_BUTTON_CLASS } from "@bb/shared-ui/sidebar-row-classes";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import { useAppCommandShortcut } from "@/components/commands/AppCommandProvider";
import { CHROME_ROW_HEIGHT_CLASS } from "@/lib/chrome-row";
import {
  useSidebarNavigation,
  useSidebarNavigationSplit,
} from "@/lib/plugin-sidebar-hooks";
import { getRootComposeRoutePath } from "@/lib/route-paths";
import { UserAvatarStack } from "@/components/users/UserAvatar";
import { useOtherOnlineUsers } from "@/components/users/user-attribution";
import { NAV_RAIL_WIDTH_CLASS } from "./SidebarChrome";
import {
  NEW_THREAD_NAVIGATION_ITEM_ID,
  SidebarNavigationIcon,
} from "./SidebarNavigationModel";

const RAIL_ICON_CLASS = "size-(--bb-sidebar-control-icon-size)";

const RAIL_BUTTON_CLASS = cn(
  "size-(--bb-sidebar-control-size) shrink-0 rounded-md p-0 text-muted-foreground ring-sidebar-ring",
  "hover:bg-state-hover hover:text-sidebar-foreground focus-visible:ring-2",
  "aria-[current=page]:bg-state-active aria-[current=page]:text-sidebar-foreground",
  "data-[state=open]:bg-state-active data-[state=open]:text-sidebar-foreground",
  "[&_[data-icon-root]]:size-(--bb-sidebar-control-icon-size)",
);

function RailButton({
  label,
  active = false,
  className,
  children,
  ref,
  ...props
}: Omit<ComponentProps<typeof Button>, "aria-label" | "aria-current"> & {
  label: string;
  active?: boolean;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          ref={ref}
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-current={active ? "page" : undefined}
          className={cn(RAIL_BUTTON_CLASS, className)}
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function RailItem({ item }: { item: SidebarNavigationItem }) {
  const { activeItemId, actions } = useSidebarNavigation();
  const split = useSidebarNavigationSplit(item.id);
  const [disablePending, setDisablePending] = useState(false);
  const button = (
    <span className="flex" data-nav-rail-item={item.id}>
      <RailButton
        label={
          item.shortcut ? `${item.label} (${item.shortcut.label})` : item.label
        }
        active={item.id === activeItemId}
        disabled={item.isDisabled}
        aria-busy={item.isLoading || undefined}
        aria-keyshortcuts={item.shortcut?.ariaKeyShortcuts}
        className={cn(item.isLoading && "opacity-60")}
        onClick={(event) =>
          actions.activate(item.id, {
            openInSplit: event.metaKey || event.ctrlKey,
          })
        }
      >
        <SidebarNavigationIcon icon={item.icon} className={RAIL_ICON_CLASS} />
      </RailButton>
    </span>
  );
  if (item.pluginId === null) return button;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{button}</ContextMenuTrigger>
      <ContextMenuContent aria-label={`${item.label} panel options`}>
        {split.isAvailable ? (
          <>
            <ContextMenuItem
              onSelect={() => actions.activate(item.id, { openInSplit: true })}
            >
              <Icon name="Columns2" aria-hidden="true" />
              Open in split
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        ) : null}
        <ContextMenuItem
          disabled={disablePending}
          onSelect={() => {
            setDisablePending(true);
            actions
              .disablePlugin(item.id)
              .catch(() => {})
              .finally(() => setDisablePending(false));
          }}
        >
          <Icon name="Unavailable" aria-hidden="true" />
          Disable
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function RailMoreMenu({
  hidden,
}: {
  hidden: readonly SidebarNavigationItem[];
}) {
  const { actions } = useSidebarNavigation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <RailButton label="More">
          <Icon name="MoreHorizontal" aria-hidden="true" />
        </RailButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start">
        {hidden.map((item) => (
          <DropdownMenuItem
            key={item.id}
            disabled={item.isDisabled || item.isLoading}
            onSelect={() => actions.activate(item.id, { openInSplit: false })}
          >
            <SidebarNavigationIcon icon={item.icon} />
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppNavRail({
  isAppMode,
  isSettingsActive,
  settingsRoutePath,
}: {
  isAppMode: boolean;
  isSettingsActive: boolean;
  settingsRoutePath: string;
}) {
  const { items, activeItemId } = useSidebarNavigation();
  const location = useLocation();
  const navigate = useNavigate();
  const settingsShortcut = useAppCommandShortcut("settings.open");
  const onlineUsers = useOtherOnlineUsers();

  const isHomeActive =
    isAppMode &&
    (activeItemId === null || activeItemId === NEW_THREAD_NAVIGATION_ITEM_ID);
  const currentRoutePath = `${location.pathname}${location.search}${location.hash}`;
  const homeRoutePathRef = useRef(
    isHomeActive ? currentRoutePath : getRootComposeRoutePath(),
  );
  useEffect(() => {
    if (isHomeActive) homeRoutePathRef.current = currentRoutePath;
  }, [currentRoutePath, isHomeActive]);

  const destinations = items.filter(
    (item) => item.action.kind !== "new-thread",
  );
  const visible = destinations.filter((item) => item.isVisible);
  const hidden = destinations.filter((item) => !item.isVisible);

  return (
    <div
      data-testid="app-nav-rail"
      className={cn("flex shrink-0 flex-col", NAV_RAIL_WIDTH_CLASS)}
    >
      <div
        aria-hidden="true"
        className={cn(CHROME_ROW_HEIGHT_CLASS, "shrink-0 bg-surface-recessed")}
      />
      <nav
        aria-label="Primary navigation"
        className="flex min-h-0 flex-1 flex-col items-center gap-2.5 bg-surface-recessed pb-2.5"
      >
        <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-2.5 overflow-y-auto py-0.5 [scrollbar-width:none]">
          <RailButton
            label="Home"
            active={isHomeActive}
            onClick={() => {
              if (!isHomeActive) void navigate(homeRoutePathRef.current);
            }}
          >
            <Icon name="Home" aria-hidden="true" />
          </RailButton>
          {visible.map((item) => (
            <RailItem key={item.id} item={item} />
          ))}
          {hidden.length > 0 ? <RailMoreMenu hidden={hidden} /> : null}
        </div>
        <UserAvatarStack
          users={onlineUsers}
          orientation="vertical"
          label="Online now"
          tooltipSide="right"
          ringClassName="ring-surface-recessed"
        />
        <RailButton
          label={
            settingsShortcut
              ? `Settings (${settingsShortcut.label})`
              : "Settings"
          }
          active={isSettingsActive}
          aria-keyshortcuts={settingsShortcut?.ariaKeyshortcuts}
          onClick={() => {
            if (!isSettingsActive) void navigate(settingsRoutePath);
          }}
        >
          <Icon name="Settings" aria-hidden="true" />
        </RailButton>
      </nav>
    </div>
  );
}

export function NavRailNewThreadButton() {
  const { items, actions, isShortcutModifierHeld } = useSidebarNavigation();
  const item = items.find(
    (candidate) => candidate.action.kind === "new-thread",
  );
  if (item === undefined) return null;
  const shortcut = isShortcutModifierHeld ? item.shortcut : null;

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className={cn(PROJECT_LIST_ACTION_BUTTON_CLASS, "w-auto flex-1")}
      disabled={item.isDisabled}
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
      <SidebarNavigationIcon icon={item.icon} />
      <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
      {shortcut ? <AppCommandShortcutPill shortcut={shortcut} /> : null}
    </Button>
  );
}
