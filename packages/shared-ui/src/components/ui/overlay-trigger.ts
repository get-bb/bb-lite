import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { cn } from "../../lib/utils";

export interface PopperProps {
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  alignOffset?: number;
  collisionBoundary?: Element | null;
  collisionPadding?: number;
}

export function popper({
  collisionBoundary,
  collisionPadding = 0,
  ...props
}: PopperProps) {
  return {
    ...props,
    collisionBoundary: collisionBoundary ?? undefined,
    collisionPadding,
    positionMethod: "fixed",
    collisionAvoidance: {
      side: "flip",
      align: "shift",
      fallbackAxisSide: "none",
    },
  } as const;
}

export function slot<P extends { asChild?: boolean; children?: ReactNode }>({
  asChild,
  children,
  ...props
}: P) {
  return asChild
    ? { ...props, render: children as ReactElement<Record<string, unknown>> }
    : { ...props, children };
}

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

function isKeyboardInputElement(element: Element): element is HTMLElement {
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement) {
    return (
      !element.disabled &&
      !element.readOnly &&
      !NON_TEXT_INPUT_TYPES.has(element.type)
    );
  }
  if (!(element instanceof HTMLElement)) return false;

  return (
    element.isContentEditable ||
    element.closest("[contenteditable='true']") !== null
  );
}

export function useOutsidePress(open: boolean, onDismiss: () => void) {
  const press = useRef({ inside: false, outside: false, right: false });
  const dismiss = useEffectEvent(onDismiss);
  useEffect(() => {
    if (!open) return;
    press.current = { inside: false, outside: false, right: false };
    const onPointerDown = (event: PointerEvent) => {
      const state = press.current;
      if (!state.inside && event.button !== 0) {
        state.outside = true;
        state.right = event.button === 2;
        dismiss();
      }
      state.inside = false;
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);
  return press;
}

const consumedEscapes = new WeakSet<Event>();

export function consumeEscape(event: Event) {
  consumedEscapes.add(event);
  event.preventDefault();
}

export function escapeAlreadyConsumed(details: {
  event: Event;
  cancel: () => void;
}) {
  if (!consumedEscapes.has(details.event)) return false;
  details.cancel();
  return true;
}

export function usePopupActions(open: boolean, popupId: string) {
  const actionsRef = useRef<{ unmount: () => void; close: () => void }>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open && !document.getElementById(popupId)) {
      actionsRef.current?.unmount();
    }
    wasOpen.current = open;
  }, [open, popupId]);
  return actionsRef;
}

export const PORTAL_CLASS =
  "pointer-events-auto [&>[data-base-ui-inert]:not([data-side])]:hidden";

let outsidePointerLocks = 0;
let bodyPointerEvents = "";

function lockOutsidePointer() {
  if (outsidePointerLocks++ === 0) {
    bodyPointerEvents = document.body.style.pointerEvents;
    document.body.style.pointerEvents = "none";
  }
  return () => {
    if (--outsidePointerLocks === 0) {
      document.body.style.pointerEvents = bodyPointerEvents;
    }
  };
}

function trapFocus(layer: Element | null) {
  let last: HTMLElement | null = null;
  const inside = (target: EventTarget | null) =>
    target instanceof Node && layer !== null && layer.contains(target);
  const restore = () => {
    const previous = document.activeElement;
    last?.focus({ preventScroll: true });
    if (last !== previous && last instanceof HTMLInputElement) last.select();
  };
  const onFocusIn = ({ target }: FocusEvent) => {
    if (!inside(target)) restore();
    else if (
      target instanceof HTMLElement &&
      !target.hasAttribute("data-base-ui-focus-guard")
    ) {
      last = target;
    }
  };
  const onFocusOut = ({ relatedTarget }: FocusEvent) => {
    if (relatedTarget !== null && !inside(relatedTarget)) restore();
  };
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onFocusOut);
  return () => {
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("focusout", onFocusOut);
  };
}

function hideOthers(layer: Element | null) {
  const hidden: Element[] = [];
  for (
    let node = layer;
    node !== null && node !== document.body;
    node = node.parentElement
  ) {
    for (const sibling of node.parentElement?.children ?? []) {
      if (
        sibling !== node &&
        sibling.getAttribute("aria-hidden") !== "true" &&
        !sibling.hasAttribute("aria-live")
      ) {
        sibling.setAttribute("aria-hidden", "true");
        hidden.push(sibling);
      }
    }
  }
  return () => {
    for (const element of hidden) element.removeAttribute("aria-hidden");
  };
}

export function useModalLayer(
  popupId: string | undefined,
  open: boolean,
  kind: "popover" | "menu",
) {
  const layer = () =>
    document.getElementById(popupId ?? "")?.closest("[data-base-ui-portal]") ??
    null;
  useEffect(() => {
    if (kind === "popover") return lockOutsidePointer();
    return hideOthers(layer());
  }, []);
  useEffect(() => {
    if (!open) return;
    const untrap = trapFocus(layer());
    const unlock = kind === "menu" ? lockOutsidePointer() : undefined;
    return () => {
      untrap();
      unlock?.();
    };
  }, [open]);
}

export function autoFocus(handler: ((event: Event) => void) | undefined) {
  return () => {
    const event = new Event("focus", { cancelable: true });
    handler?.(event);
    return !event.defaultPrevented;
  };
}

export function focusAfterClose(
  handler: ((event: Event) => void) | undefined,
  target: () => Element | null | false | undefined,
) {
  return () => {
    window.setTimeout(() => {
      const event = new Event("focus", { cancelable: true });
      handler?.(event);
      const element = event.defaultPrevented ? null : target();
      if (!(element instanceof HTMLElement)) return;
      const previous = document.activeElement;
      element.focus({ preventScroll: true });
      if (element !== previous && element instanceof HTMLInputElement) {
        element.select();
      }
    }, 0);
    return false;
  };
}

export function loopTabFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) {
    return;
  }
  const tabbable = [
    ...event.currentTarget.querySelectorAll<HTMLElement>("*"),
  ].filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(":disabled, [hidden], input[type=hidden]") &&
      element.checkVisibility({ visibilityProperty: true }),
  );
  const edge = tabbable.at(event.shiftKey ? 0 : -1) ?? event.currentTarget;
  if (document.activeElement !== edge) return;
  event.preventDefault();
  const target = tabbable.at(event.shiftKey ? -1 : 0);
  target?.focus();
  if (target instanceof HTMLInputElement) target.select();
}

export function blurActiveKeyboardInputWithin(container: Element | null): void {
  const activeElement = document.activeElement;
  if (!activeElement || !isKeyboardInputElement(activeElement)) return;
  if (container !== null && !container.contains(activeElement)) return;

  activeElement.blur();
}

export function useOverlayOpen(
  controlledOpen: boolean | undefined,
  controlledOnChange: ((open: boolean) => void) | undefined,
  defaultOpen = false,
) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  return {
    open: controlledOpen ?? internalOpen,
    onOpenChange: (next: boolean) => {
      if (controlledOpen === undefined) setInternalOpen(next);
      controlledOnChange?.(next);
    },
  };
}

export function overlayTriggerProps(open: boolean, className?: string) {
  return {
    className: cn("select-none", className),
    onMouseDown: (event: MouseEvent) => {
      if (!open) blurActiveKeyboardInputWithin(null);
      event.preventDefault();
    },
  };
}

let lastInputModality: "pointer" | "keyboard" = "pointer";

if (typeof document !== "undefined") {
  document.addEventListener(
    "keydown",
    () => {
      lastInputModality = "keyboard";
    },
    { capture: true },
  );
  document.addEventListener(
    "pointerdown",
    () => {
      lastInputModality = "pointer";
    },
    { capture: true },
  );
}

export function isLastInputKeyboard(): boolean {
  return lastInputModality === "keyboard";
}
