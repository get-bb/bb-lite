import { useEffect, useMemo, useRef, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { preventOverlayTriggerSelection } from "@bb/shared-ui/overlay-trigger";
import { usePortalScopeProps } from "@/lib/portal-scope";
import type { MessageProseSelection } from "./SelectableMessageProse.js";

const SELECTION_ACTION_BUTTON_CLASS =
  "inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-xs text-foreground transition-colors hover:bg-surface-recessed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring select-none";
const SELECTION_MENU_CONTENT_CLASS =
  "z-50 flex w-auto items-center gap-0.5 rounded-md border bg-popover p-0.5 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95";

interface SelectionAction {
  icon: IconName;
  label: string;
  onSelect: (selection: MessageProseSelection) => void;
}

export interface TimelineSelectionMenuProps {
  selection: MessageProseSelection | null;
  onAddToChat?: (text: string) => void;
  onDismiss: () => void;
}

function ActionButton({
  action,
  onDismiss,
  selection,
}: {
  action: SelectionAction;
  onDismiss: () => void;
  selection: MessageProseSelection;
}) {
  const activate = () => {
    flushSync(() => {
      action.onSelect(selection);
      window.getSelection()?.removeAllRanges();
      onDismiss();
    });
  };
  return (
    <button
      type="button"
      className={SELECTION_ACTION_BUTTON_CLASS}
      onMouseDown={(event: MouseEvent) => preventOverlayTriggerSelection(event)}
      onClick={() => {
        activate();
      }}
    >
      <Icon
        name={action.icon}
        className="size-3.5 text-muted-foreground"
        aria-hidden="true"
      />
      {action.label}
    </button>
  );
}

export function TimelineSelectionMenu({
  selection,
  onAddToChat,
  onDismiss,
}: TimelineSelectionMenuProps) {
  const open = selection !== null;
  const portalScopeProps = usePortalScopeProps();

  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    const dismiss = () => onDismiss();
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [open, onDismiss]);

  const anchorSide = selection?.anchorSide ?? "top";
  const anchorLeft =
    selection?.anchorPoint?.x ??
    (selection === null ? 0 : selection.rect.left + selection.rect.width / 2);
  const anchorTop =
    selection?.anchorPoint?.y ??
    (selection === null
      ? 0
      : anchorSide === "bottom"
        ? selection.rect.bottom
        : selection.rect.top);
  const virtualAnchor = useMemo(
    () => ({
      getBoundingClientRect: () => new DOMRect(anchorLeft, anchorTop, 0, 0),
    }),
    [anchorLeft, anchorTop],
  );
  const virtualAnchorRef = useRef(virtualAnchor);
  virtualAnchorRef.current = virtualAnchor;

  if (!selection) return null;

  const actions: SelectionAction[] = [
    ...(onAddToChat
      ? [
          {
            icon: "MessageSquarePlus" as const,
            label: "Add to chat",
            onSelect: (currentSelection: MessageProseSelection) =>
              onAddToChat(currentSelection.text),
          },
        ]
      : []),
  ];
  if (actions.length === 0) return null;

  return (
    <PopoverPrimitive.Root
      open
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
    >
      <PopoverPrimitive.Anchor virtualRef={virtualAnchorRef} />
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          {...portalScopeProps}
          side={anchorSide}
          align="center"
          sideOffset={6}
          collisionPadding={8}
          className={SELECTION_MENU_CONTENT_CLASS}
          onEscapeKeyDown={() => onDismiss()}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {actions.map((action, index) => (
            <div key={action.label} className="flex items-center">
              {index > 0 ? (
                <span
                  aria-hidden="true"
                  className="mx-0.5 h-4 w-px bg-border"
                />
              ) : null}
              <ActionButton
                action={action}
                onDismiss={onDismiss}
                selection={selection}
              />
            </div>
          ))}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
