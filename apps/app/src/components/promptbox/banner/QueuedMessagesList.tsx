import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  useSenderThreadMetadataById,
  type SenderThreadMetadata,
} from "@/hooks/useSenderThreadMetadataById";
import {
  useUserAttributionLookup,
  type UserAttributionLookup,
} from "@/components/users/user-attribution";
import type {
  PromptInput,
  PromptTextMention,
  ThreadQueuedMessage,
} from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import {
  PROMPT_STACK_EDGE_CARET_BUTTON_WIDTH_CLASS,
  PROMPT_STACK_ROW_ACTION_TAKEOVER_CLASS,
  PromptStackCard,
} from "@/components/promptbox/banner/PromptStackCard";
import { useScrollOverflowState } from "@/components/thread/timeline/useScrollOverflowState";
import { OverflowFade } from "@/components/ui/overflow-fade";
import { InlineMessageEditorFrame } from "@/components/promptbox/InlineMessageEditorFrame";
import { useBottomAnchoredScroll } from "@/components/ui/bottom-anchored-scroll-body";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@bb/shared-ui/tooltip";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  countQueuedMessageAttachments,
  formatQueuedMessagePreview,
} from "@bb/client-core";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import {
  PromptMentionPill,
  shiftMentionsToTextRange,
} from "@/components/thread/timeline/ConversationMessageMentions";
import {
  buildPromptMentionComponent,
  remarkPromptMentions,
  substitutePromptMentions,
} from "@/components/ui/markdown-prompt-mentions";
import { normalizePromptBlockquoteBoundaries } from "@/components/ui/markdown-prompt-blockquote-boundaries";
import { QueuedEditorTypeaheadLayoutContext } from "@/components/promptbox/queued-editor-typeahead-layout";

export type QueuedMessageProcessingAction = "send" | "edit" | "delete";
type QueuedMessageSendAction = "send-now" | "steer-when-ready";

export interface QueuedMessageEditRequest {
  queuedMessageId: string;
  queuedMessageIndex: number;
}

export interface QueuedMessageInlineEditor {
  content: ReactNode;
  queuedMessageId: string;
  queuedMessageIndex: number;
  onDismiss: () => void;
}

interface QueuedMessagesListProps {
  attachedToComposer: boolean;
  queuedMessages: readonly ThreadQueuedMessage[];
  resolveMentionLink?: PromptMentionLinkResolver;
  sendAction: QueuedMessageSendAction;
  sendDisabled: boolean;
  actionDisabled: boolean;
  processingMessageId: string | null;
  processingAction: QueuedMessageProcessingAction | null;
  inlineEditor?: QueuedMessageInlineEditor;
  onSend: (id: string) => void;
  onEdit: (request: QueuedMessageEditRequest) => void;
  onDelete: (id: string) => void;
}

const COLLAPSED_HEIGHT = 44;
const DRAWER_MAX_HEIGHT = 174;
const EDITING_MIN_HEIGHT = 240;
const WAIT_LINES: Record<string, { icon: IconName; label: string }> = {
  "turn-starting": { icon: "TimeSchedule", label: "Waiting for turn to start" },
  stopping: { icon: "TimeSchedule", label: "Sending when the thread stops" },
  provisioning: { icon: "Folder", label: "Waiting for workspace" },
  interaction: { icon: "CircleQuestion", label: "Waiting for your reply" },
};
const PROCESSING_LABELS: Record<QueuedMessageProcessingAction, string> = {
  send: "Sending…",
  edit: "Editing…",
  delete: "Deleting…",
};
const QUEUED_MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkPromptMentions];

const plainInline: Components["span"] = ({ children }) => (
  <span>{children}</span>
);
const spacedInline: Components["span"] = ({ children }) => (
  <span>{children} </span>
);
const headingInline: Components["span"] = ({ children }) => (
  <span className="font-semibold text-foreground">{children} </span>
);
const QUEUED_MARKDOWN_COMPONENTS: Components = {
  a: plainInline,
  blockquote: ({ children }) => (
    <span className="inline border-l-2 border-surface-selected-border pl-2 text-muted-foreground">
      {children}
    </span>
  ),
  br: () => " ",
  code: ({ children }) => (
    <code className="rounded bg-muted/70 px-1.5 py-0.5 font-mono text-xs">
      {children}
    </code>
  ),
  h1: headingInline,
  h2: headingInline,
  h3: headingInline,
  h4: headingInline,
  h5: headingInline,
  h6: headingInline,
  img: ({ alt }) => (alt ? <span>{alt}</span> : null),
  li: spacedInline,
  ol: plainInline,
  p: spacedInline,
  pre: plainInline,
  table: plainInline,
  tbody: plainInline,
  td: spacedInline,
  th: spacedInline,
  thead: plainInline,
  tr: spacedInline,
  ul: plainInline,
};

function waitLineOf(
  queuedMessage: ThreadQueuedMessage,
): { icon: IconName; label: string } | null {
  const { failureReason, waitingOn } = queuedMessage;
  if (failureReason !== null) {
    return { icon: "AlertCircle", label: failureReason };
  }
  if (waitingOn?.kind === "host-offline") {
    return {
      icon: "CloudOff",
      label: `Waiting for ${waitingOn.hostName} to be ready`,
    };
  }
  return (waitingOn && WAIT_LINES[waitingOn.kind]) ?? null;
}

function requesterNameOf(
  queuedMessage: ThreadQueuedMessage,
  lookupUser: UserAttributionLookup,
): string | null {
  if (queuedMessage.initiator !== "user") return null;
  const requester = lookupUser(queuedMessage.requestedByUserId);
  return requester === null || requester.isSelf ? null : requester.user.name;
}

function hasSecondLine(
  queuedMessage: ThreadQueuedMessage,
  processingMessageId: string | null,
  lookupUser: UserAttributionLookup,
): boolean {
  return (
    queuedMessage.initiator !== "user" ||
    requesterNameOf(queuedMessage, lookupUser) !== null ||
    waitLineOf(queuedMessage) !== null ||
    queuedMessage.id === processingMessageId
  );
}

function drawerHeight(
  queuedMessages: readonly ThreadQueuedMessage[],
  processingMessageId: string | null,
  lookupUser: UserAttributionLookup,
): number {
  const rowsHeight = queuedMessages.reduce(
    (total, queuedMessage) =>
      total +
      33 +
      (!hasSecondLine(queuedMessage, processingMessageId, lookupUser)
        ? 0
        : queuedMessage.initiator === "agent" &&
            queuedMessage.senderThreadId !== null
          ? 22
          : 16),
    0,
  );
  return Math.min(DRAWER_MAX_HEIGHT, 55 + Math.max(33, rowsHeight));
}

function senderLabelOf(
  queuedMessage: ThreadQueuedMessage,
  senderThreadMetadataById: ReadonlyMap<string, SenderThreadMetadata>,
  lookupUser: UserAttributionLookup,
): string | null {
  if (queuedMessage.initiator === "system") return "System";
  if (queuedMessage.initiator !== "agent") {
    return requesterNameOf(queuedMessage, lookupUser);
  }
  return (
    senderThreadMetadataById.get(queuedMessage.senderThreadId ?? "")?.title ??
    queuedMessage.senderThreadId ??
    "Agent"
  );
}

function markdownPreviewOf(input: readonly PromptInput[]): {
  mentions: PromptTextMention[];
  text: string;
} {
  let text = "";
  const mentions: PromptTextMention[] = [];
  for (const chunk of input) {
    if (chunk.type !== "text" || chunk.visibility === "agent-only") continue;
    const rangeStart = chunk.text.length - chunk.text.trimStart().length;
    const rangeEnd = chunk.text.trimEnd().length;
    if (rangeEnd <= rangeStart) continue;
    if (text.length > 0) text += "\n\n";
    for (const mention of shiftMentionsToTextRange({
      mentions: chunk.mentions,
      rangeStart,
      rangeEnd,
    })) {
      mentions.push({
        ...mention,
        start: mention.start + text.length,
        end: mention.end + text.length,
      });
    }
    text += chunk.text.slice(rangeStart, rangeEnd);
  }
  return { text, mentions };
}

function QueuedMessagePreview({
  compact,
  queuedMessage,
  resolveMentionLink,
}: {
  compact: boolean;
  queuedMessage: ThreadQueuedMessage;
  resolveMentionLink?: PromptMentionLinkResolver;
}) {
  const title = formatQueuedMessagePreview(queuedMessage.content, {
    truncate: false,
  });
  const preview = markdownPreviewOf(queuedMessage.content);
  const substitution = substitutePromptMentions(preview.text, preview.mentions);
  return (
    <div
      className="min-w-0 flex-1 overflow-hidden text-foreground"
      title={title}
    >
      <span
        className={cn(
          "block min-w-0 truncate",
          compact ? "!text-xs !leading-4" : "!text-sm !leading-5",
        )}
      >
        {preview.text.length === 0 ? (
          title
        ) : (
          <ReactMarkdown
            components={{
              ...QUEUED_MARKDOWN_COMPONENTS,
              "bb-prompt-mention": buildPromptMentionComponent({
                mentions: substitution.mentions,
                resolveMentionLink,
              }),
            }}
            remarkPlugins={QUEUED_MARKDOWN_REMARK_PLUGINS}
          >
            {normalizePromptBlockquoteBoundaries(substitution.content)}
          </ReactMarkdown>
        )}
      </span>
    </div>
  );
}

function RowAction({
  label,
  ariaLabel,
  icon,
  compact,
  disabled,
  destructive = false,
  onClick,
}: {
  label: string;
  ariaLabel: string;
  icon: IconName;
  compact: boolean;
  disabled: boolean;
  destructive?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className={cn(
            "shrink-0 text-muted-foreground",
            destructive && "hover:text-destructive max-md:text-destructive",
            compact ? "size-7" : "size-8",
          )}
          disabled={disabled}
          onClick={onClick}
          aria-label={ariaLabel}
        >
          <Icon name={icon} className="size-4" aria-hidden />
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-md:hidden">{label}</TooltipContent>
    </Tooltip>
  );
}

function QueuedMessageRow({
  senderLabel,
  queuedMessage,
  resolveMentionLink,
  index,
  processingLabel,
  sendAction,
  sendDisabled,
  actionDisabled,
  mobileActionsExpanded,
  onExpandMobileActions,
  onSend,
  onEdit,
  onDelete,
  compact,
}: {
  senderLabel: string | null;
  queuedMessage: ThreadQueuedMessage;
  resolveMentionLink?: PromptMentionLinkResolver;
  index: number;
  processingLabel: string | null;
  sendAction: QueuedMessageSendAction;
  sendDisabled: boolean;
  actionDisabled: boolean;
  mobileActionsExpanded: boolean;
  onExpandMobileActions: (id: string) => void;
  onSend: (id: string) => void;
  onEdit: (request: QueuedMessageEditRequest) => void;
  onDelete: (id: string) => void;
  compact: boolean;
}) {
  const actionsRef = useRef<HTMLDivElement>(null);
  const focusActionsOnExpandRef = useRef(false);
  useLayoutEffect(() => {
    if (!mobileActionsExpanded || !focusActionsOnExpandRef.current) return;
    focusActionsOnExpandRef.current = false;
    actionsRef.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus({ preventScroll: true });
  }, [mobileActionsExpanded]);
  const attachmentCount = countQueuedMessageAttachments(queuedMessage.content);
  const waitLine = waitLineOf(queuedMessage);
  const isProcessing = processingLabel !== null;
  const hasMetadata = senderLabel !== null || waitLine !== null || isProcessing;
  const failed = queuedMessage.failureReason !== null;
  const steersWhenReady = sendAction === "steer-when-ready";
  const waitKind = queuedMessage.waitingOn?.kind;
  const sendAllowed =
    steersWhenReady ||
    failed ||
    waitKind === undefined ||
    waitKind === "time" ||
    waitKind === "thread-busy";

  return (
    <li
      data-queued-message-row=""
      data-queued-message-id={queuedMessage.id}
      className={cn(
        "group/dispatch-row relative border-b border-border/35 px-2.5 py-0.5",
        index > 0 && "last:border-b-0",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span aria-hidden className="-ml-2 h-7 w-5 shrink-0" />
        <div className={cn("min-w-0 flex-1 py-1", hasMetadata && "py-1.5")}>
          <div className="flex min-w-0 items-center gap-1">
            <QueuedMessagePreview
              compact={compact}
              queuedMessage={queuedMessage}
              resolveMentionLink={resolveMentionLink}
            />
            {attachmentCount > 0 ? (
              <span
                data-queued-message-attachment=""
                className={cn(
                  "ml-auto inline-flex shrink-0 items-center gap-0.5 text-2xs text-subtle-foreground opacity-70 transition-opacity duration-[120ms] ease-out",
                  !isProcessing &&
                    "group-hover/dispatch-row:opacity-0 group-focus-within/dispatch-row:opacity-0 [@media(hover:none)]:opacity-0",
                )}
                role="img"
                aria-label={
                  attachmentCount === 1
                    ? "1 attachment"
                    : `${attachmentCount} attachments`
                }
              >
                <Icon name="FileAttachment" className="size-3.5" aria-hidden />
                <span aria-hidden>{attachmentCount}</span>
              </span>
            ) : null}
          </div>
          {hasMetadata ? (
            <div
              data-queued-message-metadata=""
              className="mt-0.5 flex min-w-0 items-center gap-1 text-2xs text-subtle-foreground"
            >
              {senderLabel === null ? null : (
                <span
                  data-queued-message-sender=""
                  className={cn(
                    "inline-flex min-w-0 items-center gap-1",
                    (isProcessing || waitLine !== null) &&
                      "max-w-[40%] shrink-0",
                  )}
                  title={`From ${senderLabel}`}
                >
                  <span className="shrink-0">From</span>
                  {queuedMessage.initiator === "agent" &&
                  queuedMessage.senderThreadId !== null ? (
                    <span className="flex min-w-0 [&>.prompt-mention-pill]:text-2xs">
                      <PromptMentionPill
                        interactive={false}
                        resource={{
                          kind: "thread",
                          threadId: queuedMessage.senderThreadId,
                          label: senderLabel,
                        }}
                        serializedText={`@thread:${queuedMessage.senderThreadId}`}
                      />
                    </span>
                  ) : (
                    <span className="min-w-0 truncate">{senderLabel}</span>
                  )}
                </span>
              )}
              {senderLabel !== null && (isProcessing || waitLine !== null) ? (
                <span aria-hidden className="shrink-0">
                  ·
                </span>
              ) : null}
              {isProcessing ? (
                <div
                  data-queued-message-processing=""
                  className="flex min-w-0 items-center gap-1 text-2xs text-muted-foreground"
                >
                  <Icon
                    name="Spinner"
                    className="size-3 shrink-0 animate-spin"
                    aria-hidden
                  />
                  <span className="min-w-0 truncate">{processingLabel}</span>
                </div>
              ) : waitLine !== null ? (
                <div
                  data-queued-message-wait=""
                  data-queued-message-failed={failed ? "" : undefined}
                  className={cn(
                    "flex min-w-0 items-center gap-1 text-2xs",
                    failed ? "text-destructive-text" : "text-subtle-foreground",
                  )}
                >
                  <Icon
                    name={waitLine.icon}
                    className="size-3 shrink-0"
                    aria-hidden
                  />
                  <span className="min-w-0 truncate">{waitLine.label}</span>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        {isProcessing ? null : (
          <TooltipProvider delayDuration={300}>
            <div
              ref={actionsRef}
              data-queued-message-actions=""
              className={cn(
                PROMPT_STACK_ROW_ACTION_TAKEOVER_CLASS,
                "pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 items-center gap-0.5 rounded-md opacity-0 transition-opacity duration-[120ms] ease-out md:flex",
                mobileActionsExpanded
                  ? "flex max-md:pointer-events-auto max-md:opacity-100"
                  : "max-md:hidden",
                "group-hover/dispatch-row:pointer-events-auto group-hover/dispatch-row:opacity-100",
                "group-focus-within/dispatch-row:pointer-events-auto group-focus-within/dispatch-row:opacity-100",
              )}
            >
              {sendAllowed ? (
                <RowAction
                  label={steersWhenReady ? "Steer when ready" : "Send now"}
                  ariaLabel={
                    steersWhenReady
                      ? `Steer queued message ${index + 1} when ready`
                      : `Send queued message ${index + 1} now`
                  }
                  icon="Sent"
                  compact={compact}
                  disabled={actionDisabled || sendDisabled}
                  onClick={() => onSend(queuedMessage.id)}
                />
              ) : null}
              {queuedMessage.editable ? (
                <RowAction
                  label="Edit"
                  ariaLabel={`Edit queued message ${index + 1}`}
                  icon="Edit"
                  compact={compact}
                  disabled={actionDisabled}
                  onClick={() =>
                    onEdit({
                      queuedMessageId: queuedMessage.id,
                      queuedMessageIndex: index,
                    })
                  }
                />
              ) : null}
              <RowAction
                label="Delete"
                ariaLabel={`Delete queued message ${index + 1}`}
                icon="Trash2"
                compact={compact}
                disabled={actionDisabled}
                destructive
                onClick={() => onDelete(queuedMessage.id)}
              />
            </div>
          </TooltipProvider>
        )}
        {isProcessing ? null : (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className={cn(
              PROMPT_STACK_ROW_ACTION_TAKEOVER_CLASS,
              "pointer-events-none absolute right-2.5 top-1/2 shrink-0 -translate-y-1/2 text-muted-foreground opacity-0 transition-opacity duration-[120ms] ease-out md:hidden",
              "group-hover/dispatch-row:pointer-events-auto group-hover/dispatch-row:opacity-100",
              "group-focus-within/dispatch-row:pointer-events-auto group-focus-within/dispatch-row:opacity-100",
              "[@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100",
              compact ? "size-7" : "size-8",
              mobileActionsExpanded && "hidden",
            )}
            disabled={actionDisabled}
            aria-label={`Queued message ${index + 1} actions`}
            aria-expanded={mobileActionsExpanded}
            onClick={(event) => {
              focusActionsOnExpandRef.current = event.detail === 0;
              onExpandMobileActions(queuedMessage.id);
            }}
          >
            <Icon name="MoreHorizontal" className="size-4" aria-hidden />
          </Button>
        )}
      </div>
    </li>
  );
}

function QueuedMessageInlineEditorSlot({
  editor,
}: {
  editor: QueuedMessageInlineEditor;
}) {
  const [typeaheadMenuHeight, setTypeaheadMenuHeight] = useState(0);
  return (
    <li
      data-queued-message-inline-editor=""
      className="relative z-10 border-b border-border/35 px-2.5 py-1 last:border-b-0"
    >
      <OverflowFade placement="above" tone="surface-raised" className="z-10" />
      <InlineMessageEditorFrame
        cancelLabel="Stop editing queued message"
        label={`Editing queued message ${editor.queuedMessageIndex + 1}`}
        onCancel={editor.onDismiss}
      >
        <QueuedEditorTypeaheadLayoutContext.Provider
          value={setTypeaheadMenuHeight}
        >
          <div
            data-queued-editor-typeahead-reservation=""
            style={{
              paddingTop:
                typeaheadMenuHeight > 0
                  ? Math.ceil(typeaheadMenuHeight) + 8
                  : 0,
            }}
          >
            {editor.content}
          </div>
        </QueuedEditorTypeaheadLayoutContext.Provider>
      </InlineMessageEditorFrame>
      <OverflowFade placement="below" tone="surface-raised" className="z-10" />
    </li>
  );
}

function QueuedMessagesListSurface({
  attachedToComposer,
  queuedMessages,
  resolveMentionLink,
  sendAction,
  sendDisabled,
  actionDisabled,
  processingMessageId,
  processingAction,
  inlineEditor,
  onSend,
  onEdit,
  onDelete,
}: QueuedMessagesListProps) {
  const senderThreadMetadataById = useSenderThreadMetadataById();
  const lookupUser = useUserAttributionLookup();
  const getScrollElement = useBottomAnchoredScroll()?.getScrollElement;
  const [collapsedPreference, setCollapsed] = useState(false);
  const [expandedMobileActionsId, setExpandedMobileActionsId] = useState<
    string | null
  >(null);
  const [editorHeight, setEditorHeight] = useState<number | null>(null);
  const surfaceRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (expandedMobileActionsId === null) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !surfaceRef.current?.contains(event.target)
      ) {
        setExpandedMobileActionsId(null);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [expandedMobileActionsId]);
  const {
    aboveOverflow,
    belowOverflow,
    bottomSentinelRef,
    scrollRef,
    topSentinelRef,
  } = useScrollOverflowState<HTMLDivElement>();
  const isEditing = inlineEditor !== undefined;
  const collapsed = collapsedPreference && !isEditing;
  const messageCount = queuedMessages.length;
  const [seenCount, setSeenCount] = useState(messageCount);
  if (seenCount !== messageCount) {
    setSeenCount(messageCount);
    if (messageCount > seenCount) setCollapsed(false);
  }

  useLayoutEffect(() => {
    if (!isEditing) {
      setEditorHeight(null);
      return;
    }
    const measure = () => {
      const surface = surfaceRef.current;
      const scroll = scrollRef.current;
      const list = listRef.current;
      const viewport = getScrollElement?.();
      const container = surface?.closest<HTMLElement>(
        "[data-app-composer]",
      )?.parentElement;
      const editorElement = list?.querySelector<HTMLElement>(
        "[data-queued-message-inline-editor]",
      );
      if (!surface || !scroll || !list || !editorElement) return;
      const isRow = (element: Element | null): element is HTMLElement =>
        element?.hasAttribute("data-queued-message-row") === true;
      const first = isRow(editorElement.previousElementSibling)
        ? editorElement.previousElementSibling
        : editorElement;
      const last = isRow(editorElement.nextElementSibling)
        ? editorElement.nextElementSibling
        : editorElement;
      const top = first.getBoundingClientRect().top;
      const surfaceHeight = surface.getBoundingClientRect().height;
      const scrollBounds = scroll.getBoundingClientRect();
      const desired = Math.max(
        EDITING_MIN_HEIGHT,
        Math.ceil(
          last.getBoundingClientRect().bottom -
            top +
            surfaceHeight -
            scrollBounds.height,
        ),
      );
      const available =
        viewport && container
          ? Math.max(
              COLLAPSED_HEIGHT,
              Math.floor(
                viewport.clientHeight -
                  Math.max(
                    0,
                    container.getBoundingClientRect().height - surfaceHeight,
                  ),
              ),
            )
          : desired;
      setEditorHeight(Math.min(desired, available));
      scroll.scrollTop += top - scrollBounds.top;
    };
    measure();
    const observer = new ResizeObserver(measure);
    const list = listRef.current;
    const editorElement = list?.querySelector(
      "[data-queued-message-inline-editor]",
    );
    for (const element of [list, editorElement, getScrollElement?.()]) {
      if (element) observer.observe(element);
    }
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [getScrollElement, isEditing, inlineEditor?.queuedMessageId, scrollRef]);

  const caretLabel = collapsed
    ? "Show queued messages"
    : "Collapse queued messages";

  const surfaceHeight = isEditing
    ? (editorHeight ?? EDITING_MIN_HEIGHT)
    : collapsed
      ? COLLAPSED_HEIGHT
      : drawerHeight(queuedMessages, processingMessageId, lookupUser);

  return (
    <PromptStackCard
      rootRef={surfaceRef}
      ariaLabel="Queued messages"
      style={{ height: surfaceHeight }}
      className={cn(
        "relative z-10 flex min-h-0 flex-col overflow-hidden bg-surface-raised-solid shadow-lift",
        isEditing || !attachedToComposer
          ? "mb-0 rounded-xl pb-4"
          : "-mb-5 rounded-xl rounded-b-none border-b-0 pb-3",
        "transition-[height,margin,border-radius,padding] duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
      )}
    >
      <header
        className={cn(
          "group/queue-header flex h-8 shrink-0 items-center gap-2 px-2",
          !collapsed && "border-b border-border/35",
        )}
        data-queued-messages-mode={collapsed ? "collapsed" : "drawer"}
      >
        <div className="flex min-w-16 items-baseline gap-1.5 pl-1">
          <span className="text-xs font-medium text-foreground">Queue</span>
          <span className="text-2xs tabular-nums text-subtle-foreground">
            {messageCount}
          </span>
        </div>
        <div className="min-w-16 flex-1" />
        <div className="flex min-w-16 items-center justify-end">
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className={cn(
                    "h-6 text-muted-foreground hover:bg-surface-recessed",
                    PROMPT_STACK_EDGE_CARET_BUTTON_WIDTH_CLASS,
                  )}
                  onClick={() => {
                    setCollapsed(!collapsed);
                    if (collapsed) return;
                    setExpandedMobileActionsId(null);
                    inlineEditor?.onDismiss();
                  }}
                  aria-label={caretLabel}
                  aria-expanded={!collapsed}
                >
                  <Icon
                    name={collapsed ? "ChevronUp" : "ChevronDown"}
                    className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover/queue-header:opacity-65 group-focus-within/queue-header:opacity-65 [@media(hover:none)]:opacity-45"
                    aria-hidden
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent className="max-md:hidden">
                {caretLabel}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </header>
      <div
        className="relative min-h-0 flex-1"
        data-queued-messages-scroll-frame=""
        aria-hidden={collapsed}
        inert={collapsed ? true : undefined}
      >
        <div
          ref={scrollRef}
          data-queued-messages-scroll=""
          className="h-full min-w-0 overflow-y-auto overflow-x-hidden overscroll-contain"
          tabIndex={collapsed ? -1 : 0}
        >
          <div ref={topSentinelRef} aria-hidden className="h-px w-full" />
          <ul ref={listRef} className="group/queue py-1">
            {queuedMessages.map((queuedMessage, index) =>
              queuedMessage.id === inlineEditor?.queuedMessageId ? (
                <QueuedMessageInlineEditorSlot
                  key={`inline-editor:${inlineEditor.queuedMessageId}`}
                  editor={inlineEditor}
                />
              ) : (
                <QueuedMessageRow
                  key={queuedMessage.id}
                  queuedMessage={queuedMessage}
                  senderLabel={senderLabelOf(
                    queuedMessage,
                    senderThreadMetadataById,
                    lookupUser,
                  )}
                  resolveMentionLink={resolveMentionLink}
                  index={index}
                  processingLabel={
                    processingMessageId === queuedMessage.id
                      ? PROCESSING_LABELS[processingAction ?? "send"]
                      : null
                  }
                  sendAction={sendAction}
                  sendDisabled={sendDisabled}
                  actionDisabled={actionDisabled}
                  compact={!isEditing}
                  mobileActionsExpanded={
                    expandedMobileActionsId === queuedMessage.id
                  }
                  onExpandMobileActions={setExpandedMobileActionsId}
                  onSend={onSend}
                  onEdit={(request) => {
                    setExpandedMobileActionsId(null);
                    onEdit(request);
                  }}
                  onDelete={onDelete}
                />
              ),
            )}
          </ul>
          <div ref={bottomSentinelRef} aria-hidden className="h-px w-full" />
        </div>
        {collapsed
          ? null
          : [aboveOverflow && "above", belowOverflow && "below"].map(
              (placement) =>
                placement === "above" || placement === "below" ? (
                  <OverflowFade
                    key={placement}
                    placement={placement}
                    tone="surface-raised"
                    inset
                    className="z-10"
                  />
                ) : null,
            )}
      </div>
    </PromptStackCard>
  );
}

export function QueuedMessagesList(props: QueuedMessagesListProps) {
  if (props.queuedMessages.length === 0 && props.inlineEditor === undefined) {
    return null;
  }
  return <QueuedMessagesListSurface {...props} />;
}
