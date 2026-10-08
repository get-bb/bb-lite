import {
  createContext,
  useContext,
  useLayoutEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { ThreadRoutePathArgs } from "../../lib/route-paths";
import type { SplitSide } from "../../lib/split-layout";

export interface PaneContextValue {
  paneId: string;
  isFocused: boolean;
  isSplitPane: boolean;
  secondaryPanelHost: PaneSecondaryPanelRegistration | null;
  reservesWindowPanelToggle: boolean;
  onRequestClose: (() => void) | null;
  isMaximized: boolean;
  onToggleMaximize: (() => void) | null;
  onMoveToSide?: (side: SplitSide) => void;
  isBoundedPane: boolean;
  isTopRow: boolean;
  ownsWindowTopLeft: boolean;
  navigateInPane: (thread: ThreadRoutePathArgs) => void;
}

export interface PaneSecondaryPanelViewModel {
  contentKey: string;
  isMainCollapsed: boolean;
  isOpen: boolean;
  panel: ReactNode;
  onToggle: () => void;
  transitionsReady: boolean;
}

export interface PaneSecondaryPanelRegistration {
  clear: () => void;
  publish: (model: PaneSecondaryPanelViewModel) => void;
}

export interface PaneSecondaryPanelRegistry {
  clear: (paneId: string) => void;
  getSnapshot: (paneId: string) => PaneSecondaryPanelViewModel | null;
  publish: (paneId: string, model: PaneSecondaryPanelViewModel) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createPaneSecondaryPanelRegistry(): PaneSecondaryPanelRegistry {
  const models = new Map<string, PaneSecondaryPanelViewModel>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  return {
    clear: (paneId) => {
      if (models.delete(paneId)) notify();
    },
    getSnapshot: (paneId) => models.get(paneId) ?? null,
    publish: (paneId, model) => {
      models.set(paneId, model);
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function usePaneSecondaryPanelModel(
  registry: PaneSecondaryPanelRegistry,
  paneId: string,
): PaneSecondaryPanelViewModel | null {
  return useSyncExternalStore(registry.subscribe, () =>
    registry.getSnapshot(paneId),
  );
}

export function usePaneSecondaryPanelRegistration(
  registration: PaneSecondaryPanelRegistration | null,
  model: PaneSecondaryPanelViewModel,
): void {
  useLayoutEffect(() => {
    registration?.publish(model);
  }, [model, registration]);
  useLayoutEffect(() => registration?.clear, [registration]);
}

export const PaneContext = createContext<PaneContextValue | null>(null);

export function usePaneContext(): PaneContextValue {
  const context = useContext(PaneContext);
  if (context === null) {
    throw new Error("usePaneContext must be used within a <PaneContext>");
  }
  return context;
}

export function useOptionalPaneContext(): PaneContextValue | null {
  return useContext(PaneContext);
}
