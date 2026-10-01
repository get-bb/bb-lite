import { useEffect, useMemo, useRef } from "react";
import type {
  SidebarNavigationActions,
  SidebarNavigationSplit,
  SidebarNavigationSplitOptions,
  SidebarNavigationState,
  PluginSidebarSplitPane,
} from "@bb/plugin/app";
import {
  useSidebarNavigationModel,
  useSidebarNavigationRowContent,
} from "@/components/sidebar/SidebarNavigationModel";
import { usePaneContentSplitIndicator } from "@/components/sidebar/paneContentSplitIndicator";
import { usePaneContentSplitDrag } from "@/components/sidebar/usePaneContentSplitDrag";

const NOOP_ACTIONS: SidebarNavigationActions = {
  activate() {},
  setVisible() {},
  setOrder() {},
  openCustomize() {},
};

const EMPTY_STATE: SidebarNavigationState = {
  items: [],
  activeItemId: null,
  isShortcutModifierHeld: false,
  actions: NOOP_ACTIONS,
};

function guardActions(
  actions: SidebarNavigationActions,
  isMounted: () => boolean,
): SidebarNavigationActions {
  return {
    activate: (itemId, options) => {
      if (isMounted()) actions.activate(itemId, options);
    },
    setVisible: (itemId, isVisible) => {
      if (isMounted()) actions.setVisible(itemId, isVisible);
    },
    setOrder: (itemIds) => {
      if (isMounted()) actions.setOrder(itemIds);
    },
    openCustomize: () => {
      if (isMounted()) actions.openCustomize();
    },
  };
}

export function useSidebarNavigation(): SidebarNavigationState {
  const state = useSidebarNavigationModel()?.state ?? EMPTY_STATE;
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const actions = useMemo(
    () => guardActions(state.actions, () => mountedRef.current),
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

const PLACEHOLDER_CONTENT = { kind: "new-thread" } as const;

export function useSidebarNavigationSplit(
  itemId: string,
  splitOptions?: SidebarNavigationSplitOptions,
): SidebarNavigationSplit {
  const model = useSidebarNavigationModel();
  const target = useSidebarNavigationRowContent(itemId);
  const enabled = target !== null && (model?.splitEnabled ?? false);
  const onNavigate = model?.onNavigate;
  const activation = splitOptions?.activation ?? "sidebar";
  const onDragStartRef = useRef(splitOptions?.onDragStart);
  useEffect(() => {
    onDragStartRef.current = splitOptions?.onDragStart;
  });
  const options = useMemo(
    () => ({
      content: target?.content ?? PLACEHOLDER_CONTENT,
      enabled,
      label: target?.label ?? "",
      dragActivation: activation,
      onDragStart: () => onDragStartRef.current?.(),
      ...(onNavigate ? { onNavigate } : {}),
    }),
    [activation, enabled, onNavigate, target],
  );
  const { onPointerDown } = usePaneContentSplitDrag(options);
  const indicator = usePaneContentSplitIndicator(options.content, enabled);
  return useMemo<SidebarNavigationSplit>(() => {
    const panes: PluginSidebarSplitPane[] | null =
      indicator.miniMap === null
        ? null
        : indicator.miniMap.map((slot) => ({
            paneId: slot.paneId,
            rect: {
              x: slot.rect.x,
              y: slot.rect.y,
              width: slot.rect.w,
              height: slot.rect.h,
            },
            isMe: slot.isMe,
            isFocused: slot.isFocused,
          }));
    return {
      splitProps: onPointerDown ? { onPointerDown } : {},
      isAvailable: onPointerDown !== undefined,
      layout: panes === null ? null : { panes },
    };
  }, [indicator.miniMap, onPointerDown]);
}
