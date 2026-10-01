import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { atom, useAtom } from "jotai";
import { atomFamily } from "jotai-family";
import type { Host } from "@bb/domain";
import type { PluginFixedTabDeclaration } from "@get-bb/plugin-sdk";
import { Button } from "@bb/shared-ui/button";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import { COARSE_POINTER_HEADER_ICON_BUTTON_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { Icon } from "@bb/shared-ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import { PluginIcon, PluginItemIcon } from "@/components/plugin/PluginIcon";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount";
import { RIGHT_PANEL_TOGGLE_ICON_NAME } from "@/components/secondary-panel/panelToggleControlState";
import { SecondaryPanelLayout } from "@/components/secondary-panel/SecondaryPanelLayout";
import {
  LazyThreadSecondaryPanel,
  LazyThreadTerminalPanel,
} from "@/components/secondary-panel/lazySecondaryPanelComponents";
import { NewTabPage } from "@/components/secondary-panel/NewTabPage";
import {
  HostScopedFilePreviewTabContent,
  ThreadStorageFilePreviewTabContent,
  WorkspaceFilePreviewTabContent,
} from "@/components/secondary-panel/ThreadSecondaryPanelTabContent";
import type {
  SecondaryPanelFixedTab,
  SecondaryPanelRenderableTab,
} from "@/components/secondary-panel/ThreadSecondaryPanel";
import { useThreadFileTabs } from "@/components/secondary-panel/useThreadFileTabs";
import {
  useCloseFixedSecondaryPanel,
  useReconciledFixedPanelTabsState,
  useUpdateFixedPanelTabsState,
} from "@/lib/fixed-panel-tabs";
import type { TerminalCreateTarget } from "@bb/server-contract";
import {
  createPluginPageFixedPanelTab,
  createTerminalFixedPanelTab,
  type PluginPageFixedPanelTab,
  type SecondaryFileFixedPanelTab,
  type TerminalFixedPanelTab,
} from "@/lib/fixed-panel-tabs-state";
import { activateSecondaryPanelTabInState } from "@bb/client-core";
import {
  useCloseTerminal,
  useCreateTerminal,
  useTerminals,
} from "@/hooks/queries/thread-terminal-queries";
import { useHosts } from "@/hooks/queries/host-queries";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { usePluginSlots } from "@/lib/plugin-slots";
import { AppNavigationHostProvider } from "@/lib/app-navigation-host";
import {
  getPluginFixedTabOwnerId,
  openAppFixedTabFromDestinations,
  type AppFixedTabDestination,
} from "@/lib/app-fixed-tab-navigation";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import {
  resolveTerminalHost,
  TerminalHostSelector,
} from "@/components/secondary-panel/TerminalHostSelector";
import { getPluginPagePanelStateId } from "./plugin-page-panel-state";
import { PluginPanelTabContent } from "./PluginPanelActions";

const TERMINAL_COLS = 100;
const TERMINAL_ROWS = 30;
const EMPTY_TERMINAL_HOSTS: readonly Host[] = [];
const RIGHT_PANEL_TOGGLE_CLASS = `${COARSE_POINTER_HEADER_ICON_BUTTON_CLASS} ${CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS}`;

const compactDrawerOpenAtomFamily = atomFamily((_panelStateId: string) =>
  atom(false),
);

function PluginFixedTabContent({
  isOpen,
  panelGeneration,
  panelId,
  pluginId,
  registration,
  subPath,
}: {
  isOpen: boolean;
  panelGeneration: number;
  panelId: string;
  pluginId: string;
  registration: PluginFixedTabDeclaration;
  subPath: string;
}) {
  if (!isOpen) return null;
  const FixedTabComponent = registration.component;
  return (
    <PluginSlotMount
      key={`${pluginId}/${panelId}/${registration.id}/${panelGeneration}`}
      pluginId={pluginId}
      slotKind="navPanelFixedTab"
      slotId={registration.id}
      instanceId={panelId}
    >
      <FixedTabComponent subPath={subPath} />
    </PluginSlotMount>
  );
}

function findPluginRightPanelTogglePortal(
  panelStateId: string,
): HTMLElement | null {
  for (const candidate of document.querySelectorAll<HTMLElement>(
    "[data-plugin-right-panel-toggle-portal]",
  )) {
    if (
      candidate.getAttribute("data-plugin-right-panel-toggle-portal") ===
      panelStateId
    ) {
      return candidate;
    }
  }
  return null;
}

function terminalScope(target: TerminalCreateTarget | null) {
  if (target?.kind !== "host_path") return target;
  return {
    kind: "host_path" as const,
    hostId: target.hostId,
    ...(target.cwd === null ? {} : { cwd: target.cwd }),
  };
}

export function PluginPanelRightPanelHost({
  children,
  panelPath,
  pluginId,
  subPath,
  flushPageInsets = false,
  paneId,
}: {
  children: ReactNode;
  panelPath: string;
  pluginId: string;
  subPath: string;
  flushPageInsets?: boolean;
  paneId?: string;
}) {
  const { navPanels } = usePluginSlots();
  const panel =
    navPanels.find(
      (candidate) =>
        candidate.pluginId === pluginId && candidate.path === panelPath,
    ) ?? null;
  const paneContext = useOptionalPaneContext();
  const isFocused = paneContext?.isFocused ?? true;
  const isHostedBySplitWorkspace = paneContext?.secondaryPanelHost != null;
  const resolvedPaneId = paneId ?? paneContext?.paneId;
  const panelHostId = resolvedPaneId ?? "standalone";
  const panelStateId = getPluginPagePanelStateId({
    panelPath,
    paneId: resolvedPaneId,
    pluginId,
  });
  const fixedViewTabs = useMemo<readonly PluginPageFixedPanelTab[]>(
    () =>
      (panel?.fixedTabs ?? []).map((fixedTab) =>
        createPluginPageFixedPanelTab({
          fixedTabId: fixedTab.id,
          pageId: panel?.id ?? panelPath,
          pluginId,
        }),
      ),
    [panel, panelPath, pluginId],
  );
  const panelState = useReconciledFixedPanelTabsState({
    fixedTabs: fixedViewTabs,
    isAuthoritative: panel !== null,
    openFirstFixedTabWhenEmpty: true,
    panelStateId,
    syncThreadId: null,
  });
  const updatePanelState = useUpdateFixedPanelTabsState(panelStateId, null);
  const closePersistedPanel = useCloseFixedSecondaryPanel(panelStateId, null);
  const [isCompactDrawerOpen, setCompactDrawerOpen] = useAtom(
    compactDrawerOpenAtomFamily(panelStateId),
  );
  const closeCompactDrawer = useCallback(() => {
    setCompactDrawerOpen(false);
  }, [setCompactDrawerOpen]);
  const isCompactViewport = useIsCompactViewport();
  const isOpen = isCompactViewport
    ? isCompactDrawerOpen
    : panelState.secondary.isOpen;
  const activeTab =
    panelState.secondary.tabs.find(
      (tab) => tab.id === panelState.secondary.activeTabId,
    ) ?? null;
  const activeTerminalTab: TerminalFixedPanelTab | null =
    activeTab?.kind === "terminal" && activeTab.target !== undefined
      ? activeTab
      : null;
  const activeTerminalTarget = activeTerminalTab?.target ?? null;
  const activeTerminalQuery = useTerminals(
    terminalScope(activeTerminalTarget),
    {
      enabled: isOpen && activeTerminalTarget !== null,
    },
  );
  const terminalSessions = activeTerminalQuery.data?.sessions;
  const terminalsById = useMemo(
    () =>
      new Map((terminalSessions ?? []).map((session) => [session.id, session])),
    [terminalSessions],
  );
  const {
    activateTab,
    closeTab,
    openTab,
    orderedSecondaryFileTabs,
    reopenClosedTab,
    reorderTab,
  } = useThreadFileTabs({
    panelStateId,
    syncThreadId: null,
    environmentId: null,
    fileOwnerThreadId: null,
    onCloseLastTab: closeCompactDrawer,
    preserveWorkspaceTabsAcrossContexts: true,
    storageFiles: undefined,
    terminalSessions: undefined,
  });
  const createTerminal = useCreateTerminal();
  const { mutateAsync: closeTerminal } = useCloseTerminal();
  const hostsQuery = useHosts();
  const primaryHostId = useSystemConfig().data?.primaryHostId ?? null;
  const [preferredTerminalHostId, setPreferredTerminalHostId] = useState<
    string | null
  >(null);
  const terminalHosts = hostsQuery.data ?? EMPTY_TERMINAL_HOSTS;
  const selectedTerminalHost = useMemo(
    () =>
      resolveTerminalHost({
        hosts: terminalHosts,
        preferredHostId: preferredTerminalHostId,
        primaryHostId,
      }),
    [preferredTerminalHostId, primaryHostId, terminalHosts],
  );

  useEffect(() => {
    if (
      activeTerminalTab === null ||
      activeTerminalQuery.isLoading ||
      activeTerminalQuery.error !== null ||
      terminalSessions === undefined ||
      terminalsById.has(activeTerminalTab.terminalId)
    ) {
      return;
    }
    closeTab(activeTerminalTab.id);
  }, [
    activeTerminalQuery.error,
    activeTerminalQuery.isLoading,
    activeTerminalTab,
    closeTab,
    terminalSessions,
    terminalsById,
  ]);

  useEffect(() => {
    closeCompactDrawer();
  }, [closeCompactDrawer, subPath]);

  const revealPanel = useCallback(() => {
    if (isCompactViewport) {
      setCompactDrawerOpen(true);
      return;
    }
    updatePanelState((state) => ({
      ...state,
      secondary: { ...state.secondary, isOpen: true },
    }));
  }, [isCompactViewport, setCompactDrawerOpen, updatePanelState]);
  const fixedTabOwnerId = getPluginFixedTabOwnerId(
    pluginId,
    panel?.id ?? panelPath,
  );
  const fixedTabDestinations = useMemo<readonly AppFixedTabDestination[]>(
    () =>
      (panel?.fixedTabs ?? []).flatMap((registration) => {
        const tab = fixedViewTabs.find(
          (candidate) => candidate.fixedTabId === registration.id,
        );
        if (tab === undefined) return [];
        return [
          {
            tab: {
              ownerId: fixedTabOwnerId,
              tabId: registration.id,
            },
            open: (target) => {
              if (target !== undefined) return false;
              updatePanelState((state) =>
                activateSecondaryPanelTabInState(state, tab.id),
              );
              revealPanel();
              return true;
            },
          },
        ];
      }),
    [
      fixedViewTabs,
      fixedTabOwnerId,
      panel?.fixedTabs,
      revealPanel,
      updatePanelState,
    ],
  );
  const openFixedTab = useCallback(
    (intent: Parameters<typeof openAppFixedTabFromDestinations>[1]) =>
      openAppFixedTabFromDestinations(fixedTabDestinations, intent),
    [fixedTabDestinations],
  );
  const navigationCapabilities = useMemo(
    () => ({ openFixedTab }),
    [openFixedTab],
  );
  const hidePanel = useCallback(() => {
    if (isCompactViewport) {
      closeCompactDrawer();
      return;
    }
    closePersistedPanel();
  }, [closeCompactDrawer, closePersistedPanel, isCompactViewport]);
  const openNewTab = useCallback(() => {
    openTab({ kind: "new-tab" });
    revealPanel();
  }, [openTab, revealPanel]);
  const togglePanel = useCallback(() => {
    if (isOpen) {
      hidePanel();
      return;
    }
    if (activeTab === null) openTab({ kind: "new-tab" });
    revealPanel();
  }, [activeTab, hidePanel, isOpen, openTab, revealPanel]);

  useAppCommandHandler("panel.toggle", () => {
    if (!isFocused || panel === null) return false;
    togglePanel();
    return true;
  });
  useAppCommandHandler("panel.newTab", () => {
    if (!isFocused || panel === null) return false;
    openNewTab();
    return true;
  });
  useAppCommandHandler("panel.reopenClosedTab", () => {
    if (!isFocused || panel === null || !reopenClosedTab()) return false;
    revealPanel();
    return true;
  });

  const [togglePortalTarget, setTogglePortalTarget] =
    useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setTogglePortalTarget(findPluginRightPanelTogglePortal(panelStateId));
  }, [panel, panelStateId]);

  const startTerminal = useCallback(
    (target: TerminalCreateTarget, replaceNewTabId?: string) => {
      if (createTerminal.isPending) return;
      void createTerminal
        .mutateAsync({
          cols: TERMINAL_COLS,
          rows: TERMINAL_ROWS,
          target,
        })
        .then((session) => {
          const tab = createTerminalFixedPanelTab({
            terminalId: session.id,
            target,
          });
          updatePanelState((state) => {
            const tabs = state.secondary.tabs.filter(
              (candidate) =>
                candidate.id !==
                  (replaceNewTabId ?? state.secondary.activeTabId) ||
                candidate.kind !== "new-tab",
            );
            return {
              ...state,
              secondary: {
                ...state.secondary,
                tabs: [...tabs, tab],
                activeTabId: tab.id,
                isOpen: isCompactViewport ? state.secondary.isOpen : true,
              },
            };
          });
          revealPanel();
        })
        .catch(() => undefined);
    },
    [createTerminal, isCompactViewport, revealPanel, updatePanelState],
  );
  const startSelectedTerminal = useCallback(
    (replaceNewTabId?: string) => {
      if (selectedTerminalHost?.status !== "connected") return;
      startTerminal(
        {
          kind: "host_path",
          hostId: selectedTerminalHost.id,
          cwd: null,
        },
        replaceNewTabId,
      );
    },
    [selectedTerminalHost, startTerminal],
  );

  useAppCommandHandler("terminal.open", () => {
    if (
      !isFocused ||
      panel === null ||
      createTerminal.isPending ||
      selectedTerminalHost?.status !== "connected"
    ) {
      return false;
    }
    startSelectedTerminal();
    return true;
  });

  const closeTerminalTab = useCallback(
    (tab: TerminalFixedPanelTab) => {
      void closeTerminal({ mode: "force", terminalId: tab.terminalId })
        .then(() => closeTab(tab.id))
        .catch(() => undefined);
    },
    [closeTab, closeTerminal],
  );

  const fixedTabs = useMemo<readonly SecondaryPanelFixedTab[]>(
    () =>
      (panel?.fixedTabs ?? []).flatMap((registration) => {
        const tab = fixedViewTabs.find(
          (candidate) => candidate.fixedTabId === registration.id,
        );
        if (tab === undefined) return [];
        return [
          {
            ariaLabel: registration.title,
            contentFillsRegion: registration.layout === "flush",
            label: registration.title,
            leadingVisual: (
              <PluginItemIcon
                pluginId={pluginId}
                icon={registration.icon}
                className="size-3.5"
              />
            ),
            onSelect: () => {
              openFixedTab({
                surface: { kind: "current" },
                tab: {
                  ownerId: fixedTabOwnerId,
                  tabId: registration.id,
                },
              });
            },
            renderContent: () =>
              panel === null ? null : (
                <PluginFixedTabContent
                  isOpen={isOpen}
                  panelGeneration={panel.generation}
                  panelId={panel.id}
                  pluginId={pluginId}
                  registration={registration}
                  subPath={subPath}
                />
              ),
            tab,
            title: registration.title,
          },
        ];
      }),
    [
      fixedViewTabs,
      fixedTabOwnerId,
      isOpen,
      openFixedTab,
      panel,
      pluginId,
      subPath,
    ],
  );

  const renderPanelTabContent = useCallback(
    function renderTabContent(tab: SecondaryFileFixedPanelTab): ReactNode {
      switch (tab.kind) {
        case "terminal":
          if (tab.target === undefined) return null;
          return (
            <LazyThreadTerminalPanel
              canCreateTerminal
              fixedPanelTarget={tab.target}
              fixedTerminalId={tab.terminalId}
              isPanelOpen={isOpen}
              isPanelPersistedOpen={panelState.secondary.isOpen}
              panelStateId={panelStateId}
              syncThreadId={null}
              target={tab.target}
            />
          );
        case "new-tab":
          return (
            <NewTabPage
              autoFocus={false}
              projectId={undefined}
              environmentId={null}
              currentThreadId=""
              onAutoFocusHandled={() => undefined}
              onSelect={() => undefined}
              onStartTerminal={() => {
                activateTab(tab.id);
                startSelectedTerminal(tab.id);
              }}
              showFileSearch={false}
              startTerminalDisabled={
                createTerminal.isPending ||
                selectedTerminalHost?.status !== "connected"
              }
              startTerminalTrailing={
                <TerminalHostSelector
                  disabled={createTerminal.isPending}
                  hosts={terminalHosts}
                  isLoading={hostsQuery.isLoading}
                  onChange={setPreferredTerminalHostId}
                  selectedHostId={selectedTerminalHost?.id ?? null}
                />
              }
            />
          );
        case "workspace-file-preview":
          return tab.environmentId === null ? null : (
            <WorkspaceFilePreviewTabContent
              activePath={tab.path}
              environmentId={tab.environmentId}
              isPanelOpen={isOpen}
              lineRange={tab.lineRange}
              source={tab.source}
              statusLabel={tab.statusLabel}
            />
          );
        case "host-file-preview":
          return tab.hostId === null ? null : (
            <HostScopedFilePreviewTabContent
              activePath={tab.path}
              hostId={tab.hostId}
              isPanelOpen={isOpen}
              lineRange={tab.lineRange}
            />
          );
        case "thread-storage-file-preview":
          return tab.threadId === null ? null : (
            <ThreadStorageFilePreviewTabContent
              activePath={tab.path}
              isPanelOpen={isOpen}
              lineRange={tab.lineRange}
              threadId={tab.threadId}
            />
          );
        case "plugin-panel":
          return (
            <PluginPanelTabContent tab={tab} context={{ kind: "new-thread" }} />
          );
      }
    },
    [
      activateTab,
      createTerminal.isPending,
      hostsQuery.isLoading,
      isOpen,
      panelState.secondary.isOpen,
      panelStateId,
      selectedTerminalHost,
      startSelectedTerminal,
      terminalHosts,
    ],
  );
  const panelTabs = useMemo<readonly SecondaryPanelRenderableTab[]>(
    () =>
      orderedSecondaryFileTabs.flatMap((tab): SecondaryPanelRenderableTab[] => {
        const shared = {
          onSelect: () => {
            activateTab(tab.id);
            revealPanel();
          },
          renderContent: () => renderPanelTabContent(tab),
          tab,
        };
        switch (tab.kind) {
          case "terminal": {
            if (tab.target === undefined) return [];
            const session = terminalsById.get(tab.terminalId);
            return [
              {
                ...shared,
                contentFillsRegion: true,
                label: session?.title ?? "Terminal",
                leadingVisual: <Icon name="Terminal" className="size-3.5" />,
                statusLabel:
                  session === undefined || session.status === "running"
                    ? null
                    : session.status,
                onClose: () => closeTerminalTab(tab),
              },
            ];
          }
          case "new-tab":
            return [
              {
                ...shared,
                label: "New tab",
                leadingVisual: <Icon name="NewTab" className="size-3.5" />,
                statusLabel: null,
                onClose: () => closeTab(tab.id),
              },
            ];
          case "workspace-file-preview":
          case "host-file-preview":
          case "thread-storage-file-preview":
            return [
              {
                ...shared,
                isPinned:
                  tab.kind === "thread-storage-file-preview" && tab.isPinned,
                label: tab.path.split(/[\\/]/u).at(-1) ?? tab.path,
                leadingVisual: <Icon name="File" className="size-3.5" />,
                statusLabel:
                  tab.kind === "workspace-file-preview"
                    ? tab.statusLabel
                    : null,
                onClose: () => closeTab(tab.id),
              },
            ];
          case "plugin-panel":
            return [
              {
                ...shared,
                contentFillsRegion: true,
                label: tab.title,
                leadingVisual: (
                  <PluginIcon
                    pluginId={tab.pluginId}
                    icon={null}
                    className="size-3.5"
                  />
                ),
                statusLabel: null,
                onClose: () => closeTab(tab.id),
              },
            ];
        }
      }),
    [
      activateTab,
      closeTab,
      closeTerminalTab,
      orderedSecondaryFileTabs,
      renderPanelTabContent,
      revealPanel,
      terminalsById,
    ],
  );

  const renderPanel = useCallback(
    ({
      presentation,
      isMainCollapsed,
      onToggleMainCollapse,
      resizablePanelId,
    }: {
      presentation: "inline" | "drawer";
      isMainCollapsed: boolean;
      onToggleMainCollapse: () => void;
      resizablePanelId?: string;
    }) => {
      return (
        <LazyThreadSecondaryPanel
          activeTab={activeTab}
          canUseGitUi={false}
          metadataContent={null}
          tabs={panelTabs}
          splitPanelStateId={panelStateId}
          onTabReorder={reorderTab}
          isOpen={isOpen}
          fixedTabs={fixedTabs}
          showConversationCollapseControl={false}
          onPanelFocus={() => undefined}
          onCollapse={hidePanel}
          onClose={hidePanel}
          onOpenNewTab={openNewTab}
          isConversationCollapsed={isMainCollapsed}
          onToggleConversationCollapse={onToggleMainCollapse}
          renderAsDrawer={presentation === "drawer"}
          resizablePanelId={resizablePanelId}
        />
      );
    },
    [
      activeTab,
      fixedTabs,
      hidePanel,
      isOpen,
      openNewTab,
      panelStateId,
      panelTabs,
      reorderTab,
    ],
  );

  const toggleLabel = isOpen ? "Hide right panel" : "Show right panel";
  const toggleIconName = RIGHT_PANEL_TOGGLE_ICON_NAME;
  const page = (
    <div
      className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${
        flushPageInsets
          ? "-m-4 h-[calc(100%+2rem)] md:-m-5 md:h-[calc(100%+2.5rem)]"
          : "h-full"
      }`}
    >
      <SecondaryPanelLayout
        open={isOpen}
        onToggle={togglePanel}
        onClose={hidePanel}
        panelGroupKey={`plugin-panel-host:${panelHostId}`}
        resetKey={panelStateId}
        contentKey={panelStateId}
        drawerLabel="Right panel"
        drawerFallback={null}
        mainPanelId={`plugin-panel-main-${panelHostId}`}
        main={children}
        composerHost={null}
        renderPanel={renderPanel}
      />
    </div>
  );

  const routedPage = (
    <>
      {panel !== null &&
      togglePortalTarget !== null &&
      !isOpen &&
      !isHostedBySplitWorkspace
        ? createPortal(
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={RIGHT_PANEL_TOGGLE_CLASS}
                  aria-label={toggleLabel}
                  aria-pressed={isOpen}
                  onClick={togglePanel}
                >
                  <Icon name={toggleIconName} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{toggleLabel}</TooltipContent>
            </Tooltip>,
            togglePortalTarget,
          )
        : null}
      {page}
    </>
  );

  return (
    <AppNavigationHostProvider capabilities={navigationCapabilities}>
      {routedPage}
    </AppNavigationHostProvider>
  );
}
