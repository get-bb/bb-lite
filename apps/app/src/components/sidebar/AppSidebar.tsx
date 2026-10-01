import { useCallback, useEffect, useRef, useState } from "react";
import { THREAD_JUMP_APP_COMMAND_IDS } from "@bb/domain";
import { useNavigate } from "react-router-dom";
import { OverflowFade } from "@/components/ui/overflow-fade.js";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
} from "@/components/ui/sidebar.js";
import { PluginThreadList } from "./PluginThreadList";
import { useThreadListReplacement } from "./threadListProvider";
import { PluginSidebarFooterItems } from "@/components/plugin/PluginSidebarFooterItems";
import { SidebarPluginAttentionGlyph } from "./SidebarPluginAttentionGlyph";
import { SidebarResizeHandle, SidebarTopReserveRow } from "./SidebarChrome";
import { SIDEBAR_FOOTER_ACTION_CLASS } from "./sidebarRowClasses";
import { getRootComposeRoutePath, getThreadRoutePath } from "@/lib/route-paths";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import {
  EMPTY_SIDEBAR_THREAD_SHORTCUT_KEYS,
  getSidebarThreadNavigationTargets,
  getSidebarThreadShortcutTargets,
  SidebarThreadShortcutKeysContext,
  type SidebarThreadShortcutPresentation,
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
import {
  resolveCustomizeFocusReturnTarget,
  SidebarNavigationRegion,
} from "./SidebarNavigationRegion";
import { SidebarNavigationModelProvider } from "./SidebarNavigationModel";
import { SidebarHeaderSlot } from "./SidebarHeaderSlot";

const BUG_REPORT_NEW_ISSUE_URL = "https://github.com/get-bb/bb/issues/new";

interface AppSidebarProps {
  onResizeMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
  isResizing: boolean;
  settingsRoutePath: string;
}

export function AppSidebar({
  onResizeMouseDown,
  isResizing,
  settingsRoutePath,
}: AppSidebarProps) {
  const threadListReplacement = useThreadListReplacement();
  const { threadId: activeThreadId } = useRouteState();
  const navigate = useNavigate();
  const [isNavigationCustomizing, setNavigationCustomizing] = useState(false);
  const customizeFocusReturnRef = useRef<HTMLElement | null>(null);
  const [threadShortcutKeysById, setThreadShortcutKeysById] = useState<
    ReadonlyMap<string, SidebarThreadShortcutPresentation>
  >(EMPTY_SIDEBAR_THREAD_SHORTCUT_KEYS);
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const threadShortcutTargetsRef = useRef<
    readonly SidebarThreadShortcutTarget[]
  >([]);
  const threadJumpShortcuts = useAppCommandShortcuts(
    THREAD_JUMP_APP_COMMAND_IDS,
  );
  const isAppCommandModifierHeld = useIsAppCommandModifierHeld();
  const settingsShortcut = useAppCommandShortcut("settings.open");

  const handleNewChat = useCallback(() => {
    void navigate(getRootComposeRoutePath(), {
      state: { focusPrompt: true },
    });
  }, [navigate]);

  const showThreadShortcuts = useCallback(() => {
    const targets = getSidebarThreadShortcutTargets(sidebarRef.current);
    threadShortcutTargetsRef.current = targets;
    setThreadShortcutKeysById(
      new Map(
        targets.flatMap((target, index) => {
          const command = THREAD_JUMP_APP_COMMAND_IDS[index];
          const shortcut = command
            ? threadJumpShortcuts.get(command)
            : undefined;
          return shortcut ? [[target.threadId, shortcut] as const] : [];
        }),
      ),
    );
  }, [threadJumpShortcuts]);

  const hideThreadShortcuts = useCallback(() => {
    threadShortcutTargetsRef.current = [];
    setThreadShortcutKeysById(EMPTY_SIDEBAR_THREAD_SHORTCUT_KEYS);
  }, []);

  const activateThreadShortcut = useCallback((index: number): boolean => {
    const targets = threadShortcutTargetsRef.current;
    const target =
      targets[index] ??
      getSidebarThreadShortcutTargets(sidebarRef.current)[index];
    if (!target?.element) return false;
    target.element.click();
    return true;
  }, []);

  const activateAdjacentThread = useCallback(
    (offset: -1 | 1): boolean => {
      const targets = getSidebarThreadNavigationTargets(sidebarRef.current);
      if (targets.length === 0) return false;
      const activeIndex = targets.findIndex(
        (target) => target.threadId === activeThreadId,
      );
      const nextIndex =
        activeIndex === -1
          ? offset === 1
            ? 0
            : targets.length - 1
          : (activeIndex + offset + targets.length) % targets.length;
      const target = targets[nextIndex];
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
    },
    [activeThreadId, navigate],
  );

  const openNavigationCustomize = useCallback(() => {
    customizeFocusReturnRef.current = resolveCustomizeFocusReturnTarget(
      sidebarRef.current,
    );
    setNavigationCustomizing(true);
  }, []);
  useIndexedAppCommandHandlers(
    THREAD_JUMP_APP_COMMAND_IDS,
    activateThreadShortcut,
  );
  useAppCommandHandler("thread.previous", () => activateAdjacentThread(-1));
  useAppCommandHandler("thread.next", () => activateAdjacentThread(1));

  useEffect(() => {
    if (isAppCommandModifierHeld) {
      showThreadShortcuts();
      return;
    }
    hideThreadShortcuts();
  }, [hideThreadShortcuts, isAppCommandModifierHeld, showThreadShortcuts]);

  const body = (
    <>
      <SidebarTopReserveRow
        testId="app-sidebar-top-reserve-row"
        renderHeaderSlot={(startInsetClassName) => (
          <SidebarHeaderSlot
            hidden={isNavigationCustomizing}
            startInsetClassName={startInsetClassName}
          />
        )}
      />
      <SidebarNavigationRegion
        isCustomizing={isNavigationCustomizing}
        onCustomizingChange={setNavigationCustomizing}
        focusReturnTargetRef={customizeFocusReturnRef}
      />
      <SidebarContent>
        <PluginThreadList replacement={threadListReplacement} />
      </SidebarContent>
      <SidebarFooter className="relative">
        <OverflowFade placement="above" tone="sidebar" size="sm" />
        <SidebarMenu className="flex-row items-center gap-1">
          <PluginSidebarFooterItems
            builtInActions={[
              {
                id: "settings",
                href: settingsRoutePath,
                ariaLabel: settingsShortcut
                  ? `Settings (${settingsShortcut.label})`
                  : "Settings",
                ariaKeyShortcuts: settingsShortcut?.ariaKeyshortcuts,
                onActivate: () => {
                  void navigate(settingsRoutePath);
                },
              },
              {
                id: "report-bug",
                onActivate: () => {
                  openUrlInExternalBrowser(BUG_REPORT_NEW_ISSUE_URL);
                },
              },
            ]}
          />
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
    </>
  );

  return (
    <SidebarThreadShortcutKeysContext.Provider value={threadShortcutKeysById}>
      <SidebarNavigationModelProvider
        onNewChat={handleNewChat}
        onOpenCustomize={openNavigationCustomize}
        splitEnabled
      >
        <Sidebar ref={sidebarRef}>{body}</Sidebar>
      </SidebarNavigationModelProvider>
    </SidebarThreadShortcutKeysContext.Provider>
  );
}
