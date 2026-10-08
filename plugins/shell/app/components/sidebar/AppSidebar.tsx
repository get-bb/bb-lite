import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@bb/shared-ui/lib/utils";
import { THREAD_JUMP_APP_COMMAND_IDS } from "@bb/domain";
import { Link, useNavigate } from "react-router-dom";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { OverflowFade } from "@bb/app-kit/components/ui/overflow-fade";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useCloseMobileSidebar,
} from "@bb/app-kit/components/ui/sidebar";
import { PluginThreadList } from "./PluginThreadList";
import { SidebarPluginAttentionGlyph } from "./SidebarPluginAttentionGlyph";
import {
  SidebarResizeHandle,
  SidebarTopReserveRow,
} from "@bb/app-kit/components/sidebar/SidebarChrome";
import { SIDEBAR_FOOTER_ACTION_CLASS } from "@bb/shared-ui/sidebar-row-classes";
import { getThreadRoutePath } from "@bb/app-kit/lib/route-paths";
import type { AppShortcutPresentation } from "@bb/app-kit/lib/app-keybindings";
import { openUrlInExternalBrowser } from "@bb/app-kit/lib/url-open-routing";
import {
  getSidebarThreadTargets,
  SidebarThreadShortcutKeysContext,
  type SidebarThreadShortcutTarget,
} from "@bb/app-kit/components/sidebar/sidebarThreadShortcuts";
import {
  useAppCommandHandler,
  useAppCommandShortcut,
  useAppCommandShortcuts,
  useIsAppCommandModifierHeld,
  useIndexedAppCommandHandlers,
} from "@bb/app-kit/components/commands/AppCommandProvider";
import { useRouteState } from "@bb/app-kit/hooks/useRouteState";
import { SidebarNavigationRegion } from "./SidebarNavigationRegion";
import { SidebarNavigationModelProvider } from "./SidebarNavigationModel";
import { SidebarHeaderSlot } from "./SidebarHeaderSlot";
import { NavRailNewThreadButton } from "./AppNavRail";
import { UserAvatarStack } from "@bb/app-kit/components/users/UserAvatar";
import { useOtherOnlineUsers } from "@bb/app-kit/components/users/user-attribution";

const BUG_REPORT_NEW_ISSUE_URL = "https://github.com/get-bb/bb/issues/new";
const NO_SHORTCUT_KEYS: ReadonlyMap<string, AppShortcutPresentation> =
  new Map();

function FooterItem({
  id,
  icon,
  label,
  ariaLabel = label,
  ariaKeyShortcuts,
  href,
  onClick,
}: {
  id: string;
  icon: IconName;
  label: string;
  ariaLabel?: string;
  ariaKeyShortcuts?: string;
  href?: string;
  onClick?: () => void;
}) {
  const content: ReactNode = (
    <>
      <Icon name={icon} className="size-4 shrink-0" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </>
  );
  return (
    <SidebarMenuItem
      className="min-w-0 shrink-0"
      data-footer-item={`builtin:${id}`}
    >
      <SidebarMenuButton
        asChild={href !== undefined}
        id={`sidebar-footer-${id}`}
        aria-label={ariaLabel}
        aria-keyshortcuts={ariaKeyShortcuts}
        tooltip={{ children: ariaLabel, hidden: false, side: "top" }}
        className={SIDEBAR_FOOTER_ACTION_CLASS}
        onClick={href === undefined ? onClick : undefined}
      >
        {href === undefined ? (
          content
        ) : (
          <Link to={href} onClick={onClick}>
            {content}
          </Link>
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function AppSidebar({
  onResizeMouseDown,
  isResizing,
  settingsRoutePath,
  mobileHosted,
  navRail,
}: {
  onResizeMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
  isResizing: boolean;
  settingsRoutePath: string;
  mobileHosted?: { hidden: boolean };
  navRail?: { hidden: boolean; rail: ReactNode; alternateBody: ReactNode };
}) {
  const { threadId: activeThreadId } = useRouteState();
  const navigate = useNavigate();
  const closeOnMobile = useCloseMobileSidebar();
  const isHiddenHostedBody =
    mobileHosted?.hidden === true || navRail?.hidden === true;
  const [threadShortcutKeysById, setThreadShortcutKeysById] =
    useState(NO_SHORTCUT_KEYS);
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const shortcutTargetsRef = useRef<readonly SidebarThreadShortcutTarget[]>([]);
  const threadJumpShortcuts = useAppCommandShortcuts(
    THREAD_JUMP_APP_COMMAND_IDS,
  );
  const isModifierHeld = useIsAppCommandModifierHeld();
  const settingsShortcut = useAppCommandShortcut("settings.open");
  const onlineUsers = useOtherOnlineUsers();

  useEffect(() => {
    const targets = isModifierHeld
      ? getSidebarThreadTargets(sidebarRef.current, 9)
      : [];
    shortcutTargetsRef.current = targets;
    setThreadShortcutKeysById(
      targets.length === 0
        ? NO_SHORTCUT_KEYS
        : new Map(
            targets.flatMap((target, index) => {
              const command = THREAD_JUMP_APP_COMMAND_IDS[index];
              const shortcut = command && threadJumpShortcuts.get(command);
              return shortcut ? [[target.threadId, shortcut] as const] : [];
            }),
          ),
    );
  }, [isModifierHeld, threadJumpShortcuts]);

  useIndexedAppCommandHandlers(THREAD_JUMP_APP_COMMAND_IDS, (index) => {
    if (isHiddenHostedBody) return false;
    const target =
      shortcutTargetsRef.current[index] ??
      getSidebarThreadTargets(sidebarRef.current, 9)[index];
    if (!target?.element) return false;
    target.element.click();
    return true;
  });
  const activateAdjacentThread = (offset: -1 | 1): boolean => {
    const targets = getSidebarThreadTargets(
      sidebarRef.current,
      Number.POSITIVE_INFINITY,
    );
    const activeIndex = targets.findIndex(
      (target) => target.threadId === activeThreadId,
    );
    const target =
      targets[
        activeIndex === -1
          ? offset === 1
            ? 0
            : targets.length - 1
          : (activeIndex + offset + targets.length) % targets.length
      ];
    if (!target) return false;
    if (target.element) {
      target.element.click();
      return true;
    }
    if (!target.projectId) return false;
    closeOnMobile();
    void navigate(
      getThreadRoutePath({
        projectId: target.projectId,
        threadId: target.threadId,
      }),
    );
    return true;
  };
  useAppCommandHandler("thread.previous", () =>
    isHiddenHostedBody ? false : activateAdjacentThread(-1),
  );
  useAppCommandHandler("thread.next", () =>
    isHiddenHostedBody ? false : activateAdjacentThread(1),
  );

  const body = (
    <>
      <SidebarTopReserveRow
        testId="app-sidebar-top-reserve-row"
        besideNavRail={navRail !== undefined}
        renderHeaderSlot={(startInsetClassName) =>
          navRail ? (
            <div
              data-testid="nav-rail-header"
              data-sidebar-header-slot=""
              className={cn(
                "flex h-full min-w-0 flex-1 items-center",
                startInsetClassName,
              )}
            >
              <NavRailNewThreadButton />
            </div>
          ) : (
            <SidebarHeaderSlot startInsetClassName={startInsetClassName} />
          )
        }
      />
      {navRail ? null : <SidebarNavigationRegion onNavigate={closeOnMobile} />}
      <SidebarContent>
        <PluginThreadList onNavigate={closeOnMobile} />
      </SidebarContent>
      <SidebarFooter className="relative">
        <OverflowFade placement="above" tone="sidebar" size="sm" />
        <SidebarMenu className="flex-row items-center gap-1">
          <SidebarMenuItem className="min-w-8 flex-1 max-md:pointer-coarse:min-w-9">
            <SidebarMenu className="flex-row items-center gap-1">
              {navRail ? null : (
                <FooterItem
                  id="settings"
                  icon="Settings"
                  label="Settings"
                  ariaLabel={
                    settingsShortcut
                      ? `Settings (${settingsShortcut.label})`
                      : "Settings"
                  }
                  ariaKeyShortcuts={settingsShortcut?.ariaKeyshortcuts}
                  href={settingsRoutePath}
                  onClick={closeOnMobile}
                />
              )}
              <FooterItem
                id="report-bug"
                icon="Bug"
                label="Report a bug"
                onClick={() => {
                  closeOnMobile();
                  openUrlInExternalBrowser(BUG_REPORT_NEW_ISSUE_URL);
                }}
              />
            </SidebarMenu>
          </SidebarMenuItem>
          {navRail ? null : (
            <UserAvatarStack
              users={onlineUsers}
              label="Online now"
              tooltipSide="top"
              ringClassName="ring-sidebar"
            />
          )}
          <SidebarPluginAttentionGlyph
            className={SIDEBAR_FOOTER_ACTION_CLASS}
            onNavigate={closeOnMobile}
          />
        </SidebarMenu>
      </SidebarFooter>
      <SidebarResizeHandle
        testId="app-sidebar-resize-handle"
        isResizing={isResizing}
        onMouseDown={onResizeMouseDown}
      />
    </>
  );

  return (
    <SidebarThreadShortcutKeysContext.Provider value={threadShortcutKeysById}>
      <SidebarNavigationModelProvider onNavigate={closeOnMobile}>
        {mobileHosted ? (
          <div
            ref={sidebarRef}
            data-testid="app-sidebar-body"
            hidden={mobileHosted.hidden}
            className="flex min-h-0 flex-1 flex-col"
          >
            {body}
          </div>
        ) : (
          <Sidebar ref={sidebarRef}>
            <div className="flex min-h-0 flex-1">
              {navRail?.rail}
              <div
                data-testid="app-sidebar-body"
                hidden={navRail?.hidden}
                className="flex min-h-0 min-w-0 flex-1 flex-col"
              >
                {body}
              </div>
              {navRail?.alternateBody}
            </div>
          </Sidebar>
        )}
      </SidebarNavigationModelProvider>
    </SidebarThreadShortcutKeysContext.Provider>
  );
}
