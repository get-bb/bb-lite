import { useState, type MouseEvent } from "react";
import { cn } from "../../lib/utils";

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
