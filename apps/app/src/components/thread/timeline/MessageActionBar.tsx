import { useEffect, useRef, useState } from "react";
import { CopyButton } from "../../ui/copy-button.js";
import { Icon } from "@bb/shared-ui/icon";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@bb/shared-ui/tooltip";
import { cn } from "@bb/shared-ui/lib/utils";
import type { PromptDraftAttachment } from "@bb/client-core";
import type { ThreadTimelineAddToChatHandler } from "./timeline-context.js";

interface MessageActionBarProps {
  messageText: string;
  alignment: "start" | "end";
  addToChatAttachments: readonly PromptDraftAttachment[];
  copyImageUrl?: string;
  onAddToChat?: ThreadTimelineAddToChatHandler;
}

const ACTION_BUTTON_CLASS =
  "inline-flex size-5 cursor-pointer items-center justify-center text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-40";
const HOVER_REVEAL_CLASS =
  "opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100";
export const PROSE_COLUMN_INSET_CLASS = "px-2";

export function MessageActionBar({
  messageText,
  alignment,
  addToChatAttachments,
  copyImageUrl,
  onAddToChat,
}: MessageActionBarProps) {
  const hasCopy = messageText.length > 0 || copyImageUrl !== undefined;
  const hasAddToChat =
    (hasCopy || addToChatAttachments.length > 0) && onAddToChat !== undefined;
  const slotRef = useRef<HTMLDivElement>(null);
  const [collisionBoundary, setCollisionBoundary] = useState<
    HTMLElement | undefined
  >();
  useEffect(() => {
    setCollisionBoundary(
      slotRef.current?.closest<HTMLElement>("[data-thread-window]") ??
        undefined,
    );
  }, []);

  if (!hasCopy && !hasAddToChat) {
    return null;
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div
        ref={slotRef}
        className={cn(
          "relative h-5 w-full",
          alignment === "end" && "pr-[13px]",
        )}
      >
        <div
          className={cn(
            "absolute top-0 flex max-w-full items-center gap-2 overflow-hidden",
            alignment === "end" ? "right-[13px]" : "left-0 -ml-1",
          )}
        >
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
                  onClick={() =>
                    addToChatAttachments.length > 0
                      ? onAddToChat(messageText, addToChatAttachments)
                      : onAddToChat(messageText)
                  }
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
        </div>
      </div>
    </TooltipProvider>
  );
}
