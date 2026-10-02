import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import type { BbNavigate } from "@bb/plugin/app";

export type PluginThreadPanelOpenHandler = (
  options: Parameters<BbNavigate["openThreadPanel"]>[0] & { pluginId: string },
) => boolean;

const PluginThreadPanelNavigationContext =
  createContext<PluginThreadPanelOpenHandler | null>(null);

export function PluginThreadPanelNavigationProvider({
  children,
  openThreadPanel,
}: {
  children: ReactNode;
  openThreadPanel: PluginThreadPanelOpenHandler;
}) {
  return (
    <PluginThreadPanelNavigationContext.Provider value={openThreadPanel}>
      {children}
    </PluginThreadPanelNavigationContext.Provider>
  );
}

export function usePluginThreadPanelOpenHandler(): PluginThreadPanelOpenHandler | null {
  return useContext(PluginThreadPanelNavigationContext);
}

const focusedOpeners = new Map<object, PluginThreadPanelOpenHandler>();

export function usePublishThreadPanelOpener(
  openThreadPanel: PluginThreadPanelOpenHandler,
  isActive: boolean,
): void {
  const handlerRef = useRef(openThreadPanel);
  useEffect(() => {
    handlerRef.current = openThreadPanel;
  });
  useEffect(() => {
    if (!isActive) return;
    focusedOpeners.set(handlerRef, (options) => handlerRef.current(options));
    return () => void focusedOpeners.delete(handlerRef);
  }, [isActive]);
}

export function getActiveThreadPanelOpener(): PluginThreadPanelOpenHandler | null {
  return [...focusedOpeners.values()].at(-1) ?? null;
}
