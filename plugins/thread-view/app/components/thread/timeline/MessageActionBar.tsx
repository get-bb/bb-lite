import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { CopyButton } from "@bb/app-kit/components/ui/copy-button";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import {
  sidePanel,
  threadView,
  type MessageAction,
  type MessageActionContext,
  type TimelineMessage,
} from "@bb/plugin/app";
import { useOwned } from "@bb/app-kit/plugins/slots";
import { usePluginThreadPanelOpenHandler } from "@bb/app-kit/components/plugin/plugin-thread-panel-navigation";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { usePointerCoarse } from "@bb/shared-ui/hooks/use-pointer-coarse";
import { copyToClipboardWithToast } from "@bb/app-kit/lib/clipboard";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@bb/shared-ui/tooltip";
import { cn } from "@bb/shared-ui/lib/utils";
import type { PromptDraftAttachment } from "@bb/client-core";
import {
  TimelineContext,
  type ThreadTimelineAddToChatHandler,
} from "./timeline-context";
import { useEditMessageAction } from "../../../lib/edit-message";

export type MobileActionDisplay = "inline" | "overflow";

interface MessageActionBarProps {
  messageText: string;
  alignment: "start" | "end";
  mobileActionDisplay: MobileActionDisplay;
  addToChatAttachments: readonly PromptDraftAttachment[];
  copyImageUrl?: string;
  seq?: number | null;
  onAddToChat?: ThreadTimelineAddToChatHandler;
}

export const ExtraMessageActionsContext = createContext<
  readonly MessageAction[]
>([]);

function selectionInside(element: HTMLElement | null): string | null {
  const selection = window.getSelection();
  const text = selection?.toString().trim() ?? "";
  if (element === null || selection === null || text === "") return null;
  return element.contains(selection.anchorNode) &&
    element.contains(selection.focusNode)
    ? text
    : null;
}

const TOUCH_ACTION_WIDTH_PX = 28;
const ACTION_ROW_GAP_PX = 8;
const OVERFLOW_TRIGGER_GAP_PX = 4;

const ACTION_BUTTON_CLASS =
  "inline-flex size-5 cursor-pointer items-center justify-center text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-40";
const HOVER_REVEAL_CLASS =
  "opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100";
const MOBILE_INLINE_ACTION_CLASS =
  "max-md:pointer-coarse:size-7 max-md:pointer-coarse:opacity-100 max-md:pointer-coarse:disabled:opacity-40 max-md:pointer-coarse:[&_[data-icon-root]]:size-4";
const MOBILE_OVERFLOW_TRIGGER_CLASS =
  "hidden size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:text-foreground max-md:pointer-coarse:inline-flex max-md:pointer-coarse:[&_[data-icon-root]]:size-4";
const ACTION_ROW_CLASS =
  "absolute top-0 flex max-w-full items-center gap-2 overflow-hidden";
const ACTION_ROW_EXPANDED_CLASS = "absolute top-0 z-10 flex items-center gap-2";
const BUBBLE_ALIGN_INSET_CLASS = "pr-[13px] max-md:pointer-coarse:pr-[11px]";
const BUBBLE_ALIGN_OFFSET_CLASS =
  "right-[13px] max-md:pointer-coarse:right-[11px]";
const PROSE_ALIGN_INSET_CLASS = "-ml-1 max-md:pointer-coarse:-ml-1.5";
export const PROSE_COLUMN_INSET_CLASS = "px-2";

function computeInlineActionCount(
  actionCount: number,
  availableWidth: number | undefined,
): number {
  if (
    availableWidth === undefined ||
    actionCount * TOUCH_ACTION_WIDTH_PX +
      (actionCount - 1) * ACTION_ROW_GAP_PX <=
      availableWidth
  ) {
    return actionCount;
  }
  return Math.max(
    0,
    Math.min(
      actionCount - 1,
      Math.floor(
        (availableWidth -
          TOUCH_ACTION_WIDTH_PX -
          OVERFLOW_TRIGGER_GAP_PX +
          ACTION_ROW_GAP_PX) /
          (TOUCH_ACTION_WIDTH_PX + ACTION_ROW_GAP_PX),
      ),
    ),
  );
}

export function MessageActionBar({
  messageText,
  alignment,
  mobileActionDisplay,
  addToChatAttachments,
  copyImageUrl,
  seq = null,
  onAddToChat,
}: MessageActionBarProps) {
  const isCompactViewport = useIsCompactViewport();
  const isPointerCoarse = usePointerCoarse();
  const useMobileActions = isCompactViewport && isPointerCoarse;
  const timeline = useContext(TimelineContext);
  const threadId = timeline?.threadId ?? null;
  const message: TimelineMessage = {
    threadId,
    role: alignment === "end" ? "user" : "assistant",
    text: messageText,
  };
  const panels = useOwned(sidePanel.panel);
  const hostOpener = usePluginThreadPanelOpenHandler();
  const extraActions = [
    ...useContext(ExtraMessageActionsContext),
    ...useEditMessageAction(threadId, seq),
  ];
  const pluginActions = [
    ...useOwned(threadView.messageAction),
    ...extraActions.map((action) => ({ ...action, pluginId: null })),
  ]
    .filter((action) => action.isAvailable?.(message) ?? true)
    .sort((left, right) => (left.order ?? 1_000) - (right.order ?? 1_000));
  const runAction = (action: MessageAction & { pluginId: string | null }) => {
    const context: MessageActionContext = {
      ...message,
      selectedText: selectionInside(
        slotRef.current?.closest<HTMLElement>('[class~="group/message"]') ??
          null,
      ),
      seq,
      openPanel: (options) => {
        const pluginId =
          panels.find(
            (panel) =>
              panel.id === options.actionId &&
              (action.pluginId === null || panel.pluginId === action.pluginId),
          )?.pluginId ?? null;
        const open = timeline?.onOpenPluginPanel ?? hostOpener ?? undefined;
        return pluginId !== null && open !== undefined
          ? open({ ...options, pluginId })
          : false;
      },
    };
    action.run(context);
  };
  const hasCopy = messageText.length > 0 || copyImageUrl !== undefined;
  const hasAddToChat =
    (hasCopy || addToChatAttachments.length > 0) && onAddToChat !== undefined;
  const slotRef = useRef<HTMLDivElement>(null);
  const expandedRowRef = useRef<HTMLDivElement>(null);
  const [collisionBoundary, setCollisionBoundary] = useState<
    HTMLElement | undefined
  >();
  const [availableWidth, setAvailableWidth] = useState<number>();
  const [expanded, setExpanded] = useState(false);
  const [copiedFromRow, setCopiedFromRow] = useState(false);
  const measuresWidth =
    useMobileActions &&
    mobileActionDisplay === "inline" &&
    (hasCopy || hasAddToChat);
  useEffect(() => {
    setCollisionBoundary(
      slotRef.current?.closest<HTMLElement>("[data-thread-window]") ??
        undefined,
    );
  }, []);
  useEffect(() => {
    const slot = slotRef.current;
    if (!measuresWidth || slot === null) return;
    const observer = new ResizeObserver(([entry]) => {
      setAvailableWidth(
        Math.floor(
          entry?.contentBoxSize?.[0]?.inlineSize ??
            entry?.contentRect.width ??
            0,
        ),
      );
    });
    observer.observe(slot);
    return () => observer.disconnect();
  }, [measuresWidth]);
  useEffect(() => {
    if (!expanded) return;
    const handlePointerDown = (event: PointerEvent) => {
      const row = expandedRowRef.current;
      if (row && event.target instanceof Node && row.contains(event.target)) {
        return;
      }
      setExpanded(false);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [expanded]);
  useEffect(() => {
    if (!copiedFromRow) return;
    const timeoutId = window.setTimeout(() => setCopiedFromRow(false), 2000);
    return () => window.clearTimeout(timeoutId);
  }, [copiedFromRow]);

  if (!hasCopy && !hasAddToChat && pluginActions.length === 0) {
    return null;
  }

  const handleAddToChat = () =>
    addToChatAttachments.length > 0
      ? onAddToChat?.(messageText, addToChatAttachments)
      : onAddToChat?.(messageText);
  const slotClass = cn(
    "relative w-full",
    alignment === "end" && BUBBLE_ALIGN_INSET_CLASS,
  );
  const rowOffsetClass =
    alignment === "end"
      ? BUBBLE_ALIGN_OFFSET_CLASS
      : cn("left-0", PROSE_ALIGN_INSET_CLASS);

  if (useMobileActions) {
    const mobileActionClass = cn(
      ACTION_BUTTON_CLASS,
      HOVER_REVEAL_CLASS,
      MOBILE_INLINE_ACTION_CLASS,
    );
    const mobileActions = (onCopied?: () => void) =>
      [
        !hasCopy ? null : onCopied ? (
          <button
            key="copy"
            type="button"
            className={mobileActionClass}
            onClick={() => {
              void copyToClipboardWithToast(messageText, {
                successMessage: null,
                errorMessage: "Failed to copy",
                imageUrl: copyImageUrl,
              }).then((didCopy) => {
                if (didCopy) onCopied();
              });
            }}
            aria-label="Copy message"
          >
            <Icon name="Copy" className="size-3" />
          </button>
        ) : (
          <CopyButton
            key="copy"
            text={messageText}
            imageUrl={copyImageUrl}
            label="Copy message"
            className={cn(HOVER_REVEAL_CLASS, MOBILE_INLINE_ACTION_CLASS)}
          />
        ),
        hasAddToChat ? (
          <button
            key="add-to-chat"
            type="button"
            className={mobileActionClass}
            onClick={handleAddToChat}
            aria-label="Add to chat"
          >
            <Icon name="MessageSquarePlus" className="size-3" />
          </button>
        ) : null,
        ...pluginActions.map((action) => (
          <button
            key={`plugin-${action.id}`}
            type="button"
            className={mobileActionClass}
            onClick={() => runAction(action)}
            aria-label={action.label}
          >
            <Icon name={action.icon as IconName} className="size-3" />
          </button>
        )),
      ].filter((action) => action !== null);
    const actionCount = mobileActions().length;
    const inlineCount =
      mobileActionDisplay === "overflow"
        ? 0
        : computeInlineActionCount(actionCount, availableWidth);
    return (
      <div ref={slotRef} className={cn(slotClass, "h-7")}>
        {expanded ? (
          <div
            ref={expandedRowRef}
            className={cn(ACTION_ROW_EXPANDED_CLASS, rowOffsetClass)}
            onClick={(event: MouseEvent<HTMLDivElement>) => {
              if ((event.target as HTMLElement | null)?.closest("button")) {
                setExpanded(false);
              }
            }}
          >
            {mobileActions(() => setCopiedFromRow(true))}
          </div>
        ) : (
          <div className={cn(ACTION_ROW_CLASS, rowOffsetClass)}>
            {mobileActions().slice(0, inlineCount)}
            {inlineCount < actionCount ? (
              <button
                type="button"
                className={cn(
                  MOBILE_OVERFLOW_TRIGGER_CLASS,
                  inlineCount > 0 && "-ml-1",
                )}
                aria-label="Message actions"
                aria-expanded={false}
                data-no-sidebar-swipe=""
                onClick={() => setExpanded(true)}
              >
                <Icon
                  name={copiedFromRow ? "Check" : "MoreHorizontal"}
                  className={cn(
                    "size-3",
                    copiedFromRow && "animate-in zoom-in-50 duration-150",
                  )}
                />
              </button>
            ) : null}
          </div>
        )}
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div ref={slotRef} className={cn(slotClass, "h-5")}>
        <div className={cn(ACTION_ROW_CLASS, rowOffsetClass)}>
          {hasCopy ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <CopyButton
                  text={messageText}
                  imageUrl={copyImageUrl}
                  label="Copy message"
                  className={HOVER_REVEAL_CLASS}
                />
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                collisionBoundary={collisionBoundary}
              >
                Copy message
              </TooltipContent>
            </Tooltip>
          ) : null}
          {hasAddToChat ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className={cn(ACTION_BUTTON_CLASS, HOVER_REVEAL_CLASS)}
                  onClick={handleAddToChat}
                  aria-label="Add to chat"
                >
                  <Icon name="MessageSquarePlus" className="size-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                collisionBoundary={collisionBoundary}
              >
                Add to chat
              </TooltipContent>
            </Tooltip>
          ) : null}
          {pluginActions.map((action) => (
            <Tooltip key={action.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className={cn(ACTION_BUTTON_CLASS, HOVER_REVEAL_CLASS)}
                  onClick={() => runAction(action)}
                  aria-label={action.label}
                >
                  <Icon name={action.icon as IconName} className="size-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                collisionBoundary={collisionBoundary}
              >
                {action.label}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      </div>
    </TooltipProvider>
  );
}
