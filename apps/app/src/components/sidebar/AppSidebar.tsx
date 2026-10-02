import { useEffect, useRef, useState, type ReactNode } from "react";
import { THREAD_JUMP_APP_COMMAND_IDS } from "@bb/domain";
import { Link, useNavigate } from "react-router-dom";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { OverflowFade } from "@/components/ui/overflow-fade.js";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar.js";
import { PluginThreadList } from "./PluginThreadList";
import { SidebarPluginAttentionGlyph } from "./SidebarPluginAttentionGlyph";
import { SidebarResizeHandle, SidebarTopReserveRow } from "./SidebarChrome";
import { SIDEBAR_FOOTER_ACTION_CLASS } from "./sidebarRowClasses";
import { getThreadRoutePath } from "@/lib/route-paths";
import type { AppShortcutPresentation } from "@/lib/app-keybindings";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import {
  getSidebarThreadTargets,
  SidebarThreadShortcutKeysContext,
  type SidebarThreadShortcutTarget,
} from "./sidebarThreadShortcuts";
import {
  useAppCommandHandler,
  useAppCommandShortcut,
  useAppCommandShortcuts,
  useIsAppCommandModifierHeld,
  useIndexedAppCommandHandlers,
} from "@/components/commands/AppCommandProvider";
import { useRouteState } from "@/hooks/useRouteState";
import { SidebarNavigationRegion } from "./SidebarNavigationRegion";
import { SidebarNavigationModelProvider } from "./SidebarNavigationModel";
import { SidebarHeaderSlot } from "./SidebarHeaderSlot";

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
        onClick={onClick}
      >
        {href === undefined ? content : <Link to={href}>{content}</Link>}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function AppSidebar({
  onResizeMouseDown,
  isResizing,
  settingsRoutePath,
}: {
  onResizeMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
  isResizing: boolean;
  settingsRoutePath: string;
}) {
  const { threadId: activeThreadId } = useRouteState();
  const navigate = useNavigate();
  const [threadShortcutKeysById, setThreadShortcutKeysById] =
    useState(NO_SHORTCUT_KEYS);
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const shortcutTargetsRef = useRef<readonly SidebarThreadShortcutTarget[]>([]);
  const threadJumpShortcuts = useAppCommandShortcuts(
    THREAD_JUMP_APP_COMMAND_IDS,
  );
  const isModifierHeld = useIsAppCommandModifierHeld();
  const settingsShortcut = useAppCommandShortcut("settings.open");

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
    void navigate(
      getThreadRoutePath({
        projectId: target.projectId,
        threadId: target.threadId,
      }),
    );
    return true;
  };
  useAppCommandHandler("thread.previous", () => activateAdjacentThread(-1));
  useAppCommandHandler("thread.next", () => activateAdjacentThread(1));

  return (
    <SidebarThreadShortcutKeysContext.Provider value={threadShortcutKeysById}>
      <SidebarNavigationModelProvider>
        <Sidebar ref={sidebarRef}>
          <SidebarTopReserveRow
            testId="app-sidebar-top-reserve-row"
            renderHeaderSlot={(startInsetClassName) => (
              <SidebarHeaderSlot startInsetClassName={startInsetClassName} />
            )}
          />
          <SidebarNavigationRegion />
          <SidebarContent>
            <PluginThreadList />
          </SidebarContent>
          <SidebarFooter className="relative">
            <OverflowFade placement="above" tone="sidebar" size="sm" />
            <SidebarMenu className="flex-row items-center gap-1">
              <SidebarMenuItem className="min-w-0 flex-1">
                <SidebarMenu className="flex-row items-center gap-1">
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
                  />
                  <FooterItem
                    id="report-bug"
                    icon="Bug"
                    label="Report a bug"
                    onClick={() =>
                      openUrlInExternalBrowser(BUG_REPORT_NEW_ISSUE_URL)
                    }
                  />
                </SidebarMenu>
              </SidebarMenuItem>
              <SidebarPluginAttentionGlyph
                className={SIDEBAR_FOOTER_ACTION_CLASS}
              />
            </SidebarMenu>
          </SidebarFooter>
          <SidebarResizeHandle
            testId="app-sidebar-resize-handle"
            isResizing={isResizing}
            onMouseDown={onResizeMouseDown}
          />
        </Sidebar>
      </SidebarNavigationModelProvider>
    </SidebarThreadShortcutKeysContext.Provider>
  );
}
