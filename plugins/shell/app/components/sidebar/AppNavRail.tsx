import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  shell,
  type ShellNavContext,
  type ShellNavItem,
  type SidebarNavigationItem,
} from "@bb/plugin/app";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { Popover, PopoverAnchor, PopoverContent } from "@bb/shared-ui/popover";
import { cn } from "@bb/shared-ui/lib/utils";
import { PROJECT_LIST_ACTION_BUTTON_CLASS } from "@bb/shared-ui/sidebar-row-classes";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import { useAppCommandShortcuts } from "@bb/app-kit/components/commands/AppCommandProvider";
import { CHROME_ROW_HEIGHT_CLASS } from "@bb/app-kit/lib/chrome-row";
import {
  useSidebarNavigation,
  useSidebarNavigationSplit,
} from "../../lib/plugin-sidebar-hooks";
import { getRootComposeRoutePath } from "@bb/app-kit/lib/route-paths";
import { useSlot } from "@bb/app-kit/plugins/slots";
import { UserAvatarStack } from "@bb/app-kit/components/users/UserAvatar";
import { useOtherOnlineUsers } from "@bb/app-kit/components/users/user-attribution";
import { NAV_RAIL_WIDTH_CLASS } from "@bb/app-kit/components/sidebar/SidebarChrome";
import {
  NEW_THREAD_NAVIGATION_ITEM_ID,
  SidebarNavigationIcon,
  useSidebarNavigationModel,
} from "./SidebarNavigationModel";
import { SidebarNavigationCustomize } from "./SidebarNavigationCustomize";

const RAIL_MENU_SIDE_OFFSET = 12;

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

function RailItem({
  item,
  onCustomize,
  onHide,
  onMenuCloseAutoFocus,
}: {
  item: SidebarNavigationItem;
  onCustomize: () => void;
  onHide: () => void;
  onMenuCloseAutoFocus: (event: Event) => void;
}) {
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
  const isPluginItem = item.pluginId !== null;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{button}</ContextMenuTrigger>
      <ContextMenuContent
        aria-label={`${item.label} options`}
        onCloseAutoFocus={onMenuCloseAutoFocus}
      >
        {isPluginItem && split.isAvailable ? (
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
        <ContextMenuItem onSelect={onHide}>
          <Icon name="EyeOff" aria-hidden="true" />
          Hide from rail
        </ContextMenuItem>
        <ContextMenuItem onSelect={onCustomize}>
          <Icon name="SlidersHorizontal" aria-hidden="true" />
          Customize rail
        </ContextMenuItem>
        {isPluginItem ? <ContextMenuSeparator /> : null}
        {isPluginItem ? (
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
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function RailMoreMenu({
  buttonRef,
  topRef,
  hidden,
  onCustomize,
  onMenuCloseAutoFocus,
}: {
  buttonRef: RefObject<HTMLButtonElement | null>;
  topRef: RefObject<HTMLDivElement | null>;
  hidden: readonly SidebarNavigationItem[];
  onCustomize: () => void;
  onMenuCloseAutoFocus: (event: Event) => void;
}) {
  const { actions } = useSidebarNavigation();
  const [topOffset, setTopOffset] = useState(0);
  return (
    <DropdownMenu
      onOpenChange={(isOpen) => {
        const button = buttonRef.current;
        const top = topRef.current;
        if (!isOpen || button === null || top === null) return;
        setTopOffset(
          top.getBoundingClientRect().top - button.getBoundingClientRect().top,
        );
      }}
    >
      <DropdownMenuTrigger asChild>
        <RailButton ref={buttonRef} label="More">
          <Icon name="MoreHorizontal" aria-hidden="true" />
        </RailButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align="start"
        alignOffset={topOffset}
        sideOffset={RAIL_MENU_SIDE_OFFSET}
        data-testid="nav-rail-more-menu"
        onCloseAutoFocus={onMenuCloseAutoFocus}
      >
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
        {hidden.length > 0 ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem onSelect={onCustomize}>
          <Icon name="SlidersHorizontal" aria-hidden="true" />
          Customize rail
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const UNORDERED = 1_000;

function ordered(
  items: readonly ShellNavItem[],
  position: ShellNavItem["position"],
): ShellNavItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.position === position)
    .sort(
      (a, b) =>
        (a.item.order ?? UNORDERED) - (b.item.order ?? UNORDERED) ||
        a.index - b.index,
    )
    .map(({ item }) => item);
}

function isHostItemActive(
  item: ShellNavItem,
  context: ShellNavContext,
): boolean {
  if (item.isActive !== undefined) return item.isActive(context);
  if (typeof item.to !== "string") return false;
  return (
    context.pathname === item.to || context.pathname.startsWith(`${item.to}/`)
  );
}

function HostRailItem({
  item,
  context,
}: {
  item: ShellNavItem;
  context: ShellNavContext;
}) {
  const command = item.command;
  const commands = useMemo(
    () => (command === undefined ? [] : [command]),
    [command],
  );
  const shortcuts = useAppCommandShortcuts(commands);
  const shortcut = command === undefined ? undefined : shortcuts.get(command);
  const active = isHostItemActive(item, context);
  return (
    <RailButton
      label={shortcut ? `${item.label} (${shortcut.label})` : item.label}
      active={active}
      aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
      onClick={() => {
        if (item.run !== undefined) {
          item.run(context);
          return;
        }
        if (active || item.to === undefined) return;
        context.navigate(
          typeof item.to === "string" ? item.to : item.to(context),
        );
      }}
    >
      <Icon name={item.icon as IconName} aria-hidden="true" />
    </RailButton>
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
  const model = useSidebarNavigationModel();
  const isCompactViewport = useIsCompactViewport();
  const [isCustomizeOpen, setIsCustomizeOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const customizeAfterMenuCloseRef = useRef(false);
  const requestCustomize = () => {
    customizeAfterMenuCloseRef.current = true;
  };
  const handleMenuCloseAutoFocus = (event: Event) => {
    if (!customizeAfterMenuCloseRef.current) return;
    customizeAfterMenuCloseRef.current = false;
    event.preventDefault();
    setIsCustomizeOpen(true);
  };
  const location = useLocation();
  const navigate = useNavigate();
  const hostItems = useSlot(shell.navItem);
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

  const context: ShellNavContext = {
    pathname: location.pathname,
    isHomeActive,
    isSettingsActive,
    get homeRoutePath() {
      return homeRoutePathRef.current;
    },
    settingsRoutePath,
    navigate: (path) => {
      void navigate(path);
    },
  };
  const topItems = ordered(hostItems, "top");
  const bottomItems = ordered(hostItems, "bottom");

  const destinations = items.filter(
    (item) => item.action.kind !== "new-thread",
  );
  const visible = destinations.filter((item) => item.isVisible);
  const hidden = destinations.filter((item) => !item.isVisible);

  return (
    <div
      data-testid="app-nav-rail"
      className={cn(
        "relative z-10 flex shrink-0 flex-col",
        NAV_RAIL_WIDTH_CLASS,
      )}
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
          <Popover open={isCustomizeOpen} onOpenChange={setIsCustomizeOpen}>
            <PopoverAnchor asChild>
              <div ref={topRef} aria-hidden="true" className="h-0 w-full" />
            </PopoverAnchor>
            {topItems.map((item) => (
              <HostRailItem key={item.id} item={item} context={context} />
            ))}
            {visible.map((item) => (
              <RailItem
                key={item.id}
                item={item}
                onCustomize={requestCustomize}
                onHide={() => model?.arrangement.setVisible(item.id, false)}
                onMenuCloseAutoFocus={handleMenuCloseAutoFocus}
              />
            ))}
            <RailMoreMenu
              buttonRef={moreButtonRef}
              topRef={topRef}
              hidden={hidden}
              onCustomize={
                isCompactViewport
                  ? () => setIsCustomizeOpen(true)
                  : requestCustomize
              }
              onMenuCloseAutoFocus={handleMenuCloseAutoFocus}
            />
            <PopoverContent
              side="right"
              align="start"
              sideOffset={RAIL_MENU_SIDE_OFFSET}
              aria-label="Customize rail"
              mobileTitle="Customize rail"
              data-testid="nav-rail-customize"
              className="flex max-h-(--radix-popover-content-available-height) flex-col p-2 md:w-64"
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                moreButtonRef.current?.focus();
              }}
            >
              <SidebarNavigationCustomize
                onClose={() => setIsCustomizeOpen(false)}
              />
            </PopoverContent>
          </Popover>
        </div>
        <UserAvatarStack
          users={onlineUsers}
          orientation="vertical"
          label="Online now"
          tooltipSide="right"
          ringClassName="ring-surface-recessed"
        />
        {bottomItems.map((item) => (
          <HostRailItem key={item.id} item={item} context={context} />
        ))}
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
      className={cn(
        PROJECT_LIST_ACTION_BUTTON_CLASS,
        "w-auto flex-1 font-medium text-sidebar-foreground",
      )}
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
