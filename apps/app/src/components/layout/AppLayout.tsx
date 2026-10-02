import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { atom, useAtom, useAtomValue, useStore } from "jotai";
import { atomWithStorage } from "jotai/utils";
import {
  matchPath,
  Navigate,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar.js";
import {
  resolveThreadTitleDisplayText,
  ThreadTitleMentionResourcesProvider,
  useSidebarThreadTitleMentionResources,
} from "@/components/thread/ThreadTitleMentions";
import { AppCommandShortcutHint } from "@/components/commands/AppCommandShortcutHint";
import { CommandPalette } from "@/components/commands/CommandPalette";
import { AppPageHeader } from "./AppPageHeader";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { listSidebarNavigationThreads } from "@/hooks/queries/thread-cache";
import {
  didThreadDetailBootstrapRefreshAfterMount,
  getLatestPendingInteraction,
  useThread,
  useThreadDetailBootstrap,
  useThreadPendingInteractions,
} from "@/hooks/queries/thread-queries";
import { useRouteState } from "@/hooks/useRouteState";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { cn } from "@bb/shared-ui/lib/utils";
import { APP_OVERLAY_LAYER } from "@/components/ui/app-overlay-layers";
import { ProjectPathDialog } from "@/components/dialogs/ProjectPathDialog";
import { PluginAppOverlays } from "@/components/plugin/PluginAppOverlays";
import { ThreadActionsProvider } from "@/components/thread/ThreadActionsProvider";
import { ProjectActionsProvider } from "@/components/project/ProjectActionsProvider";
import { usePluginNavPanelChrome } from "@/lib/plugin-nav-panel-chrome";
import {
  booleanLocalStorage,
  createLocalStorageSyncStorage,
} from "@/lib/browser-storage";
import {
  BROWSER_SIDEBAR_TRIGGER_INSET_CLASS,
  CHROME_ROW_CLASS,
} from "@/lib/chrome-row";
import {
  getRootComposeRoutePath,
  getThreadRoutePath,
  PLUGIN_PANEL_ROUTE_PATH,
  SETTINGS_ROUTE_PATH,
} from "@/lib/route-paths";
import { useQuickCreateProjectController } from "@/hooks/useQuickCreateProject";
import { IframeDragGuardOverlay } from "@/lib/iframe-drag-guard";
import { useFaviconBadge } from "@/lib/favicon-color-preference";
import { shouldShowFaviconAttentionDot } from "./faviconAttentionDot";
import { AppSidebar } from "@/components/sidebar/AppSidebar";
import { SettingsSidebar } from "@/components/settings/SettingsSidebar";
import {
  useAppCommandHandler,
  useAppCommandShortcut,
} from "@/components/commands/AppCommandProvider";
import { wsManager } from "@/lib/ws";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import { findPaneByThread } from "@/lib/split-layout";
import { applyThreadOpenToLayout } from "@/views/thread-detail/splitThreadNavigation";
import { useAppSettingsRouteMemory } from "@/hooks/useAppSettingsRouteMemory";
import { useSetRootComposeProjectId } from "@/lib/root-compose-selection";

function clampSidebarWidth(value: number) {
  return Math.min(460, Math.max(240, value));
}

const sidebarWidthAtom = atomWithStorage<number>(
  "bb.sidebar.width",
  320,
  createLocalStorageSyncStorage<number>({
    parse: (storedValue, initialValue) => {
      const parsedValue = Number(storedValue);
      return storedValue === null || !Number.isFinite(parsedValue)
        ? initialValue
        : clampSidebarWidth(parsedValue);
    },
    serialize: (value) => String(clampSidebarWidth(value)),
  }),
  { getOnInit: true },
);
const sidebarLiveWidthAtom = atom<number | null>(null);
const sidebarOpenAtom = atomWithStorage<boolean>(
  "bb.sidebar.open",
  true,
  booleanLocalStorage,
  { getOnInit: true },
);

function SidebarStateBridge({ children }: { children: ReactNode }) {
  const [open, setOpen] = useAtom(sidebarOpenAtom);
  const sidebarWidth = useAtomValue(sidebarWidthAtom);
  const sidebarLiveWidth = useAtomValue(sidebarLiveWidthAtom);
  const shortcut = useAppCommandShortcut("sidebar.toggle");
  useAppCommandHandler("sidebar.toggle", () => {
    setOpen(!open);
    return true;
  });
  return (
    <SidebarProvider
      width={`${sidebarLiveWidth ?? sidebarWidth}px`}
      data-testid="app-layout-root"
      open={open}
      onOpenChange={setOpen}
    >
      {children}
      <div
        data-testid="app-sidebar-trigger-overlay"
        style={{ zIndex: APP_OVERLAY_LAYER.sidebarTrigger }}
        className={cn(
          "fixed top-0 left-0",
          CHROME_ROW_CLASS,
          BROWSER_SIDEBAR_TRIGGER_INSET_CLASS,
        )}
      >
        <SidebarTrigger
          aria-label={
            shortcut ? `Toggle sidebar (${shortcut.label})` : "Toggle sidebar"
          }
          aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
        />
        <AppCommandShortcutHint
          shortcut={shortcut}
          className="absolute left-full ml-1"
        />
      </div>
    </SidebarProvider>
  );
}

function useSidebarResize() {
  const store = useStore();
  const [isResizing, setIsResizing] = useState(false);
  const finishRef = useRef<(() => void) | null>(null);
  useEffect(() => () => finishRef.current?.(), []);
  const onMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = store.get(sidebarWidthAtom);
    let width = startWidth;
    let frame: number | null = null;
    const onMove = (moveEvent: MouseEvent) => {
      width = clampSidebarWidth(startWidth + moveEvent.clientX - startX);
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        flushSync(() => store.set(sidebarLiveWidthAtom, width));
      });
    };
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === "Escape") finish();
    };
    const finish = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", finish);
      window.removeEventListener("blur", finish);
      window.removeEventListener("keydown", onKeyDown);
      finishRef.current = null;
      flushSync(() => {
        store.set(sidebarWidthAtom, width);
        store.set(sidebarLiveWidthAtom, null);
      });
      setIsResizing(false);
      document.body.classList.remove("sidebar-resizing");
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", finish);
    window.addEventListener("blur", finish);
    window.addEventListener("keydown", onKeyDown);
    finishRef.current = finish;
    setIsResizing(true);
    document.body.classList.add("sidebar-resizing");
  };
  return { isResizing, onMouseDown };
}

export function AppLayout({ children }: { children: ReactNode }) {
  const quickCreateProject = useQuickCreateProjectController();
  const store = useStore();
  const location = useLocation();
  const { projectId, threadId, isThreadView, isRootView } = useRouteState();
  const navigate = useNavigate();
  const { appRoutePath, settingsRoutePath } = useAppSettingsRouteMemory();
  const setRootComposeProjectId = useSetRootComposeProjectId();
  const resize = useSidebarResize();
  useEffect(
    () =>
      wsManager.onThreadOpen(({ projectId, threadId, split }) => {
        const current = store.get(splitLayoutAtom);
        const alreadyOpen =
          current !== null &&
          findPaneByThread(current.root, projectId, threadId) !== null;
        const next = applyThreadOpenToLayout(
          current,
          { projectId, threadId },
          split,
        );
        if (next !== current) store.set(splitLayoutAtom, next);
        void navigate(
          getThreadRoutePath({ projectId, threadId }),
          alreadyOpen ? { replace: true } : undefined,
        );
      }),
    [navigate, store],
  );
  useAppCommandHandler("thread.new", () => {
    if (projectId !== undefined) setRootComposeProjectId(projectId);
    void navigate(getRootComposeRoutePath(), { state: { focusPrompt: true } });
    return true;
  });
  useAppCommandHandler("settings.open", () => {
    void navigate(settingsRoutePath);
    return true;
  });
  useAppCommandHandler("settings.openServers", () => {
    void navigate(`${SETTINGS_ROUTE_PATH}/servers`);
    return true;
  });
  const isSettingsView =
    matchPath(`${SETTINGS_ROUTE_PATH}/*`, location.pathname) !== null;
  useAppCommandHandler(
    "app.back",
    () => {
      void navigate(appRoutePath);
      return true;
    },
    0,
    isSettingsView && !resize.isResizing,
  );
  const navPanelChrome = usePluginNavPanelChrome();
  const pluginPanelMatch = matchPath(
    PLUGIN_PANEL_ROUTE_PATH,
    location.pathname,
  );
  const pluginPanel = pluginPanelMatch
    ? navPanelChrome.find(
        ({ chrome }) =>
          chrome.pluginId === pluginPanelMatch.params.pluginId &&
          chrome.path === pluginPanelMatch.params.panelPath,
      )?.panel
    : undefined;
  const sidebarNavigation = useSidebarNavigation().data;
  const sidebarThreads = sidebarNavigation
    ? listSidebarNavigationThreads(sidebarNavigation)
    : [];
  const titleMentionResources =
    useSidebarThreadTitleMentionResources(sidebarNavigation);
  const bootstrapQuery = useThreadDetailBootstrap(threadId ?? "", {
    enabled: threadId !== undefined,
    timelinePrefetch: threadId !== undefined,
  });
  const { data: thread } = useThread(threadId ?? "", {
    enabled:
      threadId !== undefined &&
      (bootstrapQuery.isSuccess || bootstrapQuery.isError),
    refetchOnMount: didThreadDetailBootstrapRefreshAfterMount(bootstrapQuery)
      ? false
      : "always",
  });
  const threadProjectId = bootstrapQuery.data?.projectId;
  const pendingInteractionsQuery = useThreadPendingInteractions(
    threadId ?? "",
    { enabled: threadId !== undefined },
  );
  useFaviconBadge(
    shouldShowFaviconAttentionDot({
      currentThreadHasPendingInteraction:
        getLatestPendingInteraction(pendingInteractionsQuery.data) !== null,
      currentThreadId: threadId,
      isThreadView,
      sidebarThreads,
      thread,
    })
      ? "unread"
      : "none",
  );
  const routeTitle = isSettingsView ? "Settings" : isRootView ? "bb" : "";
  const documentTitle = isThreadView
    ? thread
      ? resolveThreadTitleDisplayText(
          getThreadDisplayTitle(thread),
          titleMentionResources,
        )
      : threadId
        ? `Thread ${threadId.slice(0, 8)}`
        : "Thread"
    : (pluginPanel?.title ?? (routeTitle || "BB"));
  useEffect(() => {
    document.title = documentTitle;
  }, [documentTitle]);

  if (
    threadId !== undefined &&
    projectId !== undefined &&
    threadProjectId !== undefined &&
    threadProjectId !== projectId
  ) {
    return (
      <Navigate
        to={{
          pathname: getThreadRoutePath({
            projectId: threadProjectId,
            threadId,
          }),
          search: location.search,
          hash: location.hash,
        }}
        replace
      />
    );
  }

  return (
    <TooltipProvider delayDuration={300} disableHoverableContent>
      <ThreadTitleMentionResourcesProvider value={titleMentionResources}>
        <ThreadActionsProvider sections={sidebarNavigation?.sections ?? []}>
          <SidebarStateBridge>
            {isSettingsView ? (
              <SettingsSidebar
                onResizeMouseDown={resize.onMouseDown}
                isResizing={resize.isResizing}
                appRoutePath={appRoutePath}
              />
            ) : (
              <AppSidebar
                onResizeMouseDown={resize.onMouseDown}
                isResizing={resize.isResizing}
                settingsRoutePath={settingsRoutePath}
              />
            )}
            <SidebarInset>
              <div
                data-testid="app-layout-content-shell"
                className="relative flex h-full min-h-0 min-w-0 w-full flex-col"
              >
                {!isThreadView && !isRootView && pluginPanelMatch === null ? (
                  <AppPageHeader
                    center={
                      routeTitle ? (
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold">
                            {routeTitle}
                          </p>
                        </div>
                      ) : null
                    }
                  />
                ) : null}
                <main className="flex min-h-0 flex-1 flex-col p-4 md:p-5">
                  <ProjectActionsProvider>{children}</ProjectActionsProvider>
                </main>
              </div>
            </SidebarInset>
          </SidebarStateBridge>
          <PluginAppOverlays />
          <IframeDragGuardOverlay
            active={resize.isResizing}
            cursor="col-resize"
          />
          <CommandPalette
            threadId={threadId ?? null}
            projectId={projectId ?? null}
          />
          <ProjectPathDialog
            target={quickCreateProject.projectPathDialog.target}
            pending={quickCreateProject.isCreating}
            hostId={quickCreateProject.hostId}
            hostName={quickCreateProject.hostName}
            hosts={quickCreateProject.hosts}
            onOpenChange={quickCreateProject.projectPathDialog.onOpenChange}
            onSubmit={quickCreateProject.submitProjectPath}
          />
        </ThreadActionsProvider>
      </ThreadTitleMentionResourcesProvider>
    </TooltipProvider>
  );
}
