import {
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

export function autoFocus(handler: ((event: Event) => void) | undefined) {
  return () => {
    const event = new Event("focus", { cancelable: true });
    handler?.(event);
    return !event.defaultPrevented;
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
