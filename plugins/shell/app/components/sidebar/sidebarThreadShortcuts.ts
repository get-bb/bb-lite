import { createContext, useContext } from "react";
import type { AppShortcutPresentation } from "@bb/app-kit/lib/app-keybindings";

const THREAD_TARGET_SELECTOR = "[data-sidebar-thread-shortcut-target]";
const WINDOWED_NAV_ATTRIBUTE = "data-sidebar-windowed-nav";

export interface SidebarThreadShortcutTarget {
  element: HTMLAnchorElement | null;
  threadId: string;
  projectId: string | null;
}

export const SidebarThreadShortcutKeysContext = createContext<
  ReadonlyMap<string, AppShortcutPresentation>
>(new Map());

export function getSidebarThreadTargets(
  root: HTMLElement | null,
  limit: number,
): SidebarThreadShortcutTarget[] {
  const targets: SidebarThreadShortcutTarget[] = [];
  const includeWindowed = limit === Number.POSITIVE_INFINITY;
  const selector = includeWindowed
    ? `${THREAD_TARGET_SELECTOR}, [${WINDOWED_NAV_ATTRIBUTE}]`
    : THREAD_TARGET_SELECTOR;
  for (const element of root?.querySelectorAll<HTMLElement>(selector) ?? []) {
    if (targets.length >= limit) break;
    if (
      element.closest("[data-sidebar-overflow='true']") ||
      !element.checkVisibility({ visibilityProperty: true })
    ) {
      continue;
    }
    if (element instanceof HTMLAnchorElement) {
      const threadId = element.dataset.sidebarThreadId;
      if (threadId) targets.push({ element, threadId, projectId: null });
      continue;
    }
    const encoded = element.getAttribute(WINDOWED_NAV_ATTRIBUTE) ?? "";
    for (const pair of encoded.split(" ")) {
      const separator = pair.indexOf(":");
      if (separator <= 0 || separator === pair.length - 1) continue;
      targets.push({
        element: null,
        threadId: pair.slice(0, separator),
        projectId: pair.slice(separator + 1),
      });
    }
  }
  return targets;
}

export function useSidebarThreadShortcut(
  threadId: string,
): AppShortcutPresentation | undefined {
  return useContext(SidebarThreadShortcutKeysContext).get(threadId);
}
