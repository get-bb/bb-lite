import { useCallback, useRef, useState } from "react";
import { CopyButton } from "../../ui/copy-button.js";
import { Icon } from "@bb/shared-ui/icon";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@bb/shared-ui/tooltip";
import { cn } from "@bb/shared-ui/lib/utils";
import type { PromptDraftAttachment } from "@bb/client-core";
import { PluginItemIcon, pluginIconName } from "@/components/plugin/PluginIcon";
import type { ThreadTimelinePluginMessageAction } from "./types.js";

function PluginActionIcon({
  pluginId,
  icon,
  className,
}: {
  pluginId: string | null;
  icon: string | null;
  className?: string;
}) {
  return pluginId === null ? (
    <Icon
      name={pluginIconName(icon)}
      className={cn("size-4 shrink-0", className)}
      aria-hidden="true"
    />
  ) : (
    <PluginItemIcon pluginId={pluginId} icon={icon} className={className} />
  );
}

interface MessageActionBarProps {
  messageText: string;
  alignment: "start" | "end";
  addToChatAttachments?: readonly PromptDraftAttachment[];
  copyImageUrl?: string;
  onAddToChat?: (
    text: string,
    attachments?: readonly PromptDraftAttachment[],
  ) => void;
  onEdit?: () => void;
  onFork?: () => void;
  disabled?: boolean;
  pluginActions?: readonly ThreadTimelinePluginMessageAction[];
}

interface MessageOverflowAction {
  icon: "Copy" | "Edit" | "MessageSquarePlus" | "Fork" | "ArrowTurnBackward";
  plugin?: { pluginId: string | null; icon: string | null };
  key?: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  copyText?: string;
  copyImageUrl?: string;
  kind?: "copy";
}

function MessageActionIcon({
  action,
  className,
  ariaHidden,
}: {
  action: MessageOverflowAction;
  className?: string;
  ariaHidden?: "true";
}) {
  return action.plugin ? (
    <PluginActionIcon
      pluginId={action.plugin.pluginId}
      icon={action.plugin.icon}
      className={className}
    />
  ) : (
    <Icon name={action.icon} className={className} aria-hidden={ariaHidden} />
  );
}

const DESKTOP_ACTION_WIDTH_PX = 20;
const ACTION_ROW_GAP_PX = 8;
const OVERFLOW_TRIGGER_GAP_PX = 4;
const OVERFLOW_TRIGGER_TIGHTEN_CLASS = "-ml-1";

function actionRowWidth(count: number): number {
  return count <= 0
    ? 0
    : count * DESKTOP_ACTION_WIDTH_PX + (count - 1) * ACTION_ROW_GAP_PX;
}

interface MessageActionRowLayout {
  inlineCount: number;
  overflowCount: number;
}

export function computeMessageActionRowLayout({
  actionCount,
  availableWidth,
}: {
  actionCount: number;
  availableWidth: number | undefined;
}): MessageActionRowLayout {
  if (actionCount <= 0) {
    return { inlineCount: 0, overflowCount: 0 };
  }
  if (availableWidth === undefined) {
    return { inlineCount: actionCount, overflowCount: 0 };
  }
  if (actionRowWidth(actionCount) <= availableWidth) {
    return { inlineCount: actionCount, overflowCount: 0 };
  }
  const inlineCount = Math.max(
    0,
    Math.min(
      actionCount - 1,
      Math.floor(
        (availableWidth -
          DESKTOP_ACTION_WIDTH_PX -
          OVERFLOW_TRIGGER_GAP_PX +
          ACTION_ROW_GAP_PX) /
          (DESKTOP_ACTION_WIDTH_PX + ACTION_ROW_GAP_PX),
      ),
    ),
  );
  return { inlineCount, overflowCount: actionCount - inlineCount };
}

function useMeasuredWidth(): {
  measureRef: (node: HTMLElement | null) => void;
  width: number | undefined;
} {
  const [width, setWidth] = useState<number | undefined>(undefined);
  const observerRef = useRef<ResizeObserver | null>(null);
  const measureRef = useCallback((node: HTMLElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (node === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      const inlineSize =
        entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
      setWidth(Math.floor(inlineSize));
    });
    observer.observe(node);
    observerRef.current = observer;
  }, []);
  return { measureRef, width };
}

const ACTION_BUTTON_CLASS =
  "inline-flex size-5 cursor-pointer items-center justify-center text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-40";
const HOVER_REVEAL_CLASS =
  "opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100";
const ACTION_TOOLTIP_SIDE = "bottom";
const MENU_CONTENT_WIDTH_CLASS = "max-w-[min(16rem,calc(100vw-1rem))]";

const ACTION_ROW_CLASS =
  "absolute top-0 flex max-w-full items-center gap-2 overflow-hidden data-[menu-open]:[&_button]:opacity-100";

const BUBBLE_ALIGN_INSET_CLASS = "pr-[13px]";
const BUBBLE_ALIGN_OFFSET_CLASS = "right-[13px]";
const PROSE_ALIGN_INSET_CLASS = "-ml-1";
export const PROSE_COLUMN_INSET_CLASS = "px-2";

export function findMessageActionTooltipCollisionBoundary(
  node: HTMLElement | null,
): HTMLElement | undefined {
  return node?.closest<HTMLElement>("[data-thread-window]") ?? undefined;
}

function DesktopMessageAction({
  action,
  className,
  collisionBoundary,
}: {
  action: MessageOverflowAction;
  className: string;
  collisionBoundary: HTMLElement | undefined;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {action.kind === "copy" ? (
          <CopyButton
            text={action.copyText ?? ""}
            imageUrl={action.copyImageUrl}
            label={action.label}
            className={className}
          />
        ) : (
          <button
            type="button"
            className={cn(ACTION_BUTTON_CLASS, className)}
            onClick={action.onSelect}
            disabled={action.disabled}
            aria-label={action.label}
          >
            <MessageActionIcon action={action} className="size-3" />
          </button>
        )}
      </TooltipTrigger>
      <TooltipContent
        side={ACTION_TOOLTIP_SIDE}
        collisionBoundary={collisionBoundary}
      >
        {action.label}
      </TooltipContent>
    </Tooltip>
  );
}

function MessageActionMenuItems({
  actions,
}: {
  actions: readonly MessageOverflowAction[];
}) {
  return actions.map((action) => (
    <DropdownMenuItem
      key={action.key ?? action.label}
      disabled={action.disabled}
      onSelect={action.onSelect}
      textValue={action.label}
    >
      <MessageActionIcon action={action} ariaHidden="true" />
      {action.label}
    </DropdownMenuItem>
  ));
}

export function MessageActionBar({
  messageText,
  alignment,
  addToChatAttachments = [],
  copyImageUrl,
  onAddToChat,
  onEdit,
  onFork,
  disabled,
  pluginActions = [],
}: MessageActionBarProps) {
  const hasCopy = messageText.length > 0 || copyImageUrl !== undefined;
  const hasAddToChat =
    (hasCopy || addToChatAttachments.length > 0) && onAddToChat !== undefined;
  const [collisionBoundary, setCollisionBoundary] = useState<
    HTMLElement | undefined
  >();
  const { measureRef, width: availableWidth } = useMeasuredWidth();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const desktopSlotRef = useCallback(
    (node: HTMLDivElement | null) => {
      measureRef(node);
      setCollisionBoundary(findMessageActionTooltipCollisionBoundary(node));
    },
    [measureRef],
  );
  const handleAddToChat = useCallback(() => {
    if (!onAddToChat) return;
    if (addToChatAttachments.length > 0) {
      onAddToChat(messageText, addToChatAttachments);
      return;
    }
    onAddToChat(messageText);
  }, [addToChatAttachments, messageText, onAddToChat]);
  const actions: MessageOverflowAction[] = [
    ...(hasCopy
      ? [
          {
            icon: "Copy" as const,
            label: "Copy message",
            onSelect: () => {
              void copyToClipboardWithToast(messageText, {
                errorMessage: "Failed to copy",
                imageUrl: copyImageUrl,
              });
            },
            copyText: messageText,
            copyImageUrl,
            kind: "copy" as const,
          },
        ]
      : []),
    ...(onEdit
      ? [
          {
            icon: "Edit" as const,
            label: "Edit message",
            onSelect: onEdit,
          },
        ]
      : []),
    ...(hasAddToChat
      ? [
          {
            icon: "MessageSquarePlus" as const,
            label: "Add to chat",
            onSelect: handleAddToChat,
          },
        ]
      : []),
    ...(onFork
      ? [
          {
            icon: "Fork" as const,
            label: "Fork into new thread",
            onSelect: onFork,
            disabled,
          },
        ]
      : []),
    ...pluginActions.map((action) => ({
      icon: "Copy" as const,
      plugin: { pluginId: action.pluginId, icon: action.icon },
      key: action.key,
      label: action.label,
      onSelect: action.onSelect,
    })),
  ];

  if (actions.length === 0) {
    return null;
  }

  const rowClass = cn(
    ACTION_ROW_CLASS,
    alignment === "end"
      ? BUBBLE_ALIGN_OFFSET_CLASS
      : cn("left-0", PROSE_ALIGN_INSET_CLASS),
  );
  const slotClass = cn(
    "relative w-full",
    alignment === "end" && BUBBLE_ALIGN_INSET_CLASS,
  );

  const layout = computeMessageActionRowLayout({
    actionCount: actions.length,
    availableWidth,
  });

  return (
    <TooltipProvider delayDuration={300}>
      <div ref={desktopSlotRef} className={cn(slotClass, "h-5")}>
        <div className={rowClass} data-menu-open={isMenuOpen ? "" : undefined}>
          {actions.slice(0, layout.inlineCount).map((action) => (
            <DesktopMessageAction
              key={action.key ?? action.label}
              action={action}
              className={HOVER_REVEAL_CLASS}
              collisionBoundary={collisionBoundary}
            />
          ))}
          {layout.overflowCount > 0 ? (
            <DropdownMenu onOpenChange={setIsMenuOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    ACTION_BUTTON_CLASS,
                    HOVER_REVEAL_CLASS,
                    layout.inlineCount > 0 && OVERFLOW_TRIGGER_TIGHTEN_CLASS,
                    "data-[state=open]:text-foreground data-[state=open]:opacity-100",
                  )}
                  aria-label="More actions"
                >
                  <Icon name="MoreHorizontal" className="size-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align={alignment === "end" ? "end" : "start"}
                className={MENU_CONTENT_WIDTH_CLASS}
              >
                <MessageActionMenuItems
                  actions={actions.slice(layout.inlineCount)}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
    </TooltipProvider>
  );
}
