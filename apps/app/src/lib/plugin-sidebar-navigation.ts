import { useEffect, useMemo, useRef } from "react";
import type {
  SidebarNavigationActions,
  PluginSidebarThreadSplit,
  SidebarNavigationState,
} from "@bb/plugin/app";
import { useSidebarNavigationModel } from "@/components/sidebar/SidebarNavigationModel";
import { usePaneContentSplitPanes } from "@/components/sidebar/paneContentSplitIndicator";

const EMPTY_STATE: SidebarNavigationState = {
  items: [],
  activeItemId: null,
  isShortcutModifierHeld: false,
  actions: { activate() {}, disablePlugin: () => Promise.resolve() },
};

export function useSidebarNavigation(): SidebarNavigationState {
  const state = useSidebarNavigationModel()?.state ?? EMPTY_STATE;
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const actions = useMemo<SidebarNavigationActions>(
    () => ({
      activate: (itemId, options) => {
        if (mountedRef.current) state.actions.activate(itemId, options);
      },
      disablePlugin: (itemId) =>
        mountedRef.current
          ? state.actions.disablePlugin(itemId)
          : Promise.resolve(),
    }),
    [state.actions],
  );
  return useMemo(
    () => ({
      items: state.items,
      activeItemId: state.activeItemId,
      isShortcutModifierHeld: state.isShortcutModifierHeld,
      actions,
    }),
    [actions, state.activeItemId, state.isShortcutModifierHeld, state.items],
  );
}

export function useSidebarNavigationSplit(
  itemId: string,
): PluginSidebarThreadSplit {
  const entry = useSidebarNavigationModel()?.entries.find(
    (candidate) => candidate.item.id === itemId,
  );
  const content = entry?.content ?? null;
  const panes = usePaneContentSplitPanes(content);
  return useMemo<PluginSidebarThreadSplit>(
    () => ({
      isAvailable: content !== null,
      layout: panes === null ? null : { panes },
    }),
    [content, panes],
  );
}
