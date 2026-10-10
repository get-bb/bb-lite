import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@bb/shared-ui/lib/utils";
import { THREAD_JUMP_APP_COMMAND_IDS } from "@bb/domain";
import { Link, useNavigate } from "react-router-dom";
import { shell } from "@bb/plugin/app";
import { SlotMount, useSlotEntries } from "@bb/app-kit/plugins/slots";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { OverflowFade } from "@bb/app-kit/components/ui/overflow-fade";
import {
  Sidebar,
  SidebarCollapsibleBody,
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
} from "./sidebarThreadShortcuts";
import {
  useAppCommandHandler,
  useAppCommandShortcuts,
  useIsAppCommandModifierHeld,
  useIndexedAppCommandHandlers,
} from "@bb/app-kit/components/commands/AppCommandProvider";
import { useRouteState } from "@bb/app-kit/hooks/useRouteState";
import { SidebarNavigationModelProvider } from "./SidebarNavigationModel";
import { NavRailNewThreadButton } from "./AppNavRail";

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
  navRail,
}: {
  onResizeMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
  isResizing: boolean;
  navRail: { hidden: boolean; rail: ReactNode; alternateBody: ReactNode };
}) {
  const { threadId: activeThreadId } = useRouteState();
  const navigate = useNavigate();
  const closeOnMobile = useCloseMobileSidebar();
  const footerEntries = useSlotEntries(shell.sidebarFooter);
  const footerItems = [...footerEntries].sort(
    (left, right) => (left.item.order ?? 1_000) - (right.item.order ?? 1_000),
  );
  const isHiddenHostedBody = navRail.hidden;
  const [threadShortcutKeysById, setThreadShortcutKeysById] =
    useState(NO_SHORTCUT_KEYS);
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const shortcutTargetsRef = useRef<readonly SidebarThreadShortcutTarget[]>([]);
  const threadJumpShortcuts = useAppCommandShortcuts(
    THREAD_JUMP_APP_COMMAND_IDS,
  );
  const isModifierHeld = useIsAppCommandModifierHeld();

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
        besideNavRail
        renderHeaderSlot={(startInsetClassName) => (
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
        )}
      />
      <SidebarContent>
        <PluginThreadList onNavigate={closeOnMobile} />
      </SidebarContent>
      <SidebarFooter className="relative">
        <OverflowFade placement="above" tone="sidebar" size="sm" />
        <SidebarMenu className="flex-row items-center gap-1">
          <SidebarMenuItem className="min-w-8 flex-1 max-md:pointer-coarse:min-w-9">
            <SidebarMenu className="flex-row items-center gap-1">
              {footerItems.map(({ plugin, item }) =>
                item.view === undefined ? (
                  <FooterItem
                    key={`${plugin}/${item.id}`}
                    id={`${plugin}-${item.id}`}
                    icon={item.icon as IconName}
                    label={item.label}
                    onClick={() => {
                      closeOnMobile();
                      item.run?.();
                    }}
                  />
                ) : (
                  <SlotMount
                    key={`${plugin}/${item.id}`}
                    pluginId={plugin}
                    slot={shell.sidebarFooter.name}
                    id={item.id}
                    fallback={null}
                  >
                    <item.view />
                  </SlotMount>
                ),
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
        <Sidebar ref={sidebarRef}>
          <div className="flex min-h-0 flex-1">
            {navRail.rail}
            <SidebarCollapsibleBody data-testid="nav-rail-sidebar-body">
              <div
                data-testid="app-sidebar-body"
                hidden={navRail.hidden}
                className="flex min-h-0 min-w-0 flex-1 flex-col"
              >
                {body}
              </div>
              {navRail.alternateBody}
            </SidebarCollapsibleBody>
          </div>
        </Sidebar>
      </SidebarNavigationModelProvider>
    </SidebarThreadShortcutKeysContext.Provider>
  );
}
