import * as React from "react";

export interface ResponsiveOverlayContextValue {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function useResponsiveRoot(
  controlledOpen: boolean | undefined,
  controlledOnChange: ((open: boolean) => void) | undefined,
  defaultOpen: boolean = false,
): ResponsiveOverlayContextValue {
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;

  const onOpenChange = React.useCallback(
    (next: boolean) => {
      if (!isControlled) {
        setInternalOpen(next);
      }
      controlledOnChange?.(next);
    },
    [isControlled, controlledOnChange],
  );

  return React.useMemo(() => ({ open, onOpenChange }), [open, onOpenChange]);
}

const PERSISTENT_DRAWER_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

type PersistentDrawerStackEntry = {
  panel: () => HTMLElement | null;
  requestClose: () => void;
};

type PersistentDrawerStack = {
  entries: PersistentDrawerStackEntry[];
  handleKeyDown: (event: KeyboardEvent) => void;
};

const persistentDrawerStacks = new WeakMap<Document, PersistentDrawerStack>();

function getDrawerFocusableElements(panel: HTMLElement): HTMLElement[] {
  return Array.from(
    panel.querySelectorAll<HTMLElement>(PERSISTENT_DRAWER_FOCUSABLE_SELECTOR),
  ).filter(
    (element) => element.closest('[aria-hidden="true"], [inert]') === null,
  );
}

function activeElementIsInAnotherOverlay(
  activeElement: Element | null,
  panel: HTMLElement,
): boolean {
  const overlay = activeElement?.closest<HTMLElement>(
    "[data-bb-portaled-overlay]",
  );
  return overlay !== null && overlay !== undefined && overlay !== panel;
}

function handleDrawerTab(event: KeyboardEvent, panel: HTMLElement): void {
  const activeElement = panel.ownerDocument.activeElement;
  if (
    !panel.contains(activeElement) &&
    activeElementIsInAnotherOverlay(activeElement, panel)
  ) {
    return;
  }

  const focusable = getDrawerFocusableElements(panel);
  event.preventDefault();
  if (focusable.length === 0) {
    panel.focus({ preventScroll: true });
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey) {
    if (
      !panel.contains(activeElement) ||
      activeElement === panel ||
      activeElement === first
    ) {
      last?.focus({ preventScroll: true });
      return;
    }
    const index = focusable.indexOf(activeElement as HTMLElement);
    focusable[Math.max(0, index - 1)]?.focus({ preventScroll: true });
    return;
  }

  if (
    !panel.contains(activeElement) ||
    activeElement === panel ||
    activeElement === last
  ) {
    first?.focus({ preventScroll: true });
    return;
  }
  const index = focusable.indexOf(activeElement as HTMLElement);
  focusable[Math.min(focusable.length - 1, index + 1)]?.focus({
    preventScroll: true,
  });
}

function registerOpenDrawer(
  ownerDocument: Document,
  entry: PersistentDrawerStackEntry,
): () => void {
  let stack = persistentDrawerStacks.get(ownerDocument);
  if (stack === undefined) {
    const entries: PersistentDrawerStackEntry[] = [];
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      const topEntry = entries[entries.length - 1];
      const panel = topEntry?.panel() ?? null;
      if (topEntry === undefined || panel === null) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        topEntry.requestClose();
      } else if (event.key === "Tab") {
        handleDrawerTab(event, panel);
      }
    };
    stack = { entries, handleKeyDown };
    persistentDrawerStacks.set(ownerDocument, stack);
    ownerDocument.addEventListener("keydown", handleKeyDown);
  }
  stack.entries.push(entry);

  return () => {
    const currentStack = persistentDrawerStacks.get(ownerDocument);
    if (currentStack === undefined) {
      return;
    }
    const index = currentStack.entries.indexOf(entry);
    if (index >= 0) {
      currentStack.entries.splice(index, 1);
    }
    if (currentStack.entries.length === 0) {
      ownerDocument.removeEventListener("keydown", currentStack.handleKeyDown);
      persistentDrawerStacks.delete(ownerDocument);
    }
  };
}

interface UsePersistentOverlayFocusArgs {
  open: boolean;
  panelRef: React.RefObject<HTMLElement | null>;
  requestClose: () => void;
}

export function usePersistentOverlayFocus({
  open,
  panelRef,
  requestClose,
}: UsePersistentOverlayFocusArgs): void {
  const returnFocusRef = React.useRef<HTMLElement | null>(null);

  React.useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (panel === null) return;
    const ownerDocument = panel.ownerDocument;
    const previousFocus = ownerDocument.activeElement;
    returnFocusRef.current =
      previousFocus instanceof HTMLElement &&
      previousFocus !== ownerDocument.body
        ? previousFocus
        : null;
    const unregister = registerOpenDrawer(ownerDocument, {
      panel: () => panelRef.current,
      requestClose,
    });
    panel.focus({ preventScroll: true });
    return unregister;
  }, [open, panelRef, requestClose]);

  const previousOpenRef = React.useRef(open);
  React.useLayoutEffect(() => {
    let cancelDeferredFocus: (() => void) | undefined;
    if (previousOpenRef.current && !open) {
      const returnFocus = returnFocusRef.current;
      if (
        returnFocus?.isConnected &&
        returnFocus.closest('[aria-hidden="true"], [inert]') === null
      ) {
        returnFocus.focus({ preventScroll: true });
        if (returnFocus.ownerDocument.activeElement !== returnFocus) {
          const ownerWindow = returnFocus.ownerDocument.defaultView;
          if (ownerWindow !== null) {
            const frame = ownerWindow.requestAnimationFrame(() => {
              if (
                returnFocus.isConnected &&
                returnFocus.closest('[aria-hidden="true"], [inert]') === null
              ) {
                returnFocus.focus({ preventScroll: true });
              }
            });
            cancelDeferredFocus = () => ownerWindow.cancelAnimationFrame(frame);
          }
        }
      }
      returnFocusRef.current = null;
    }
    previousOpenRef.current = open;
    return cancelDeferredFocus;
  }, [open]);
}
