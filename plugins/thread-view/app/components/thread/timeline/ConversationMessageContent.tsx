import { useMemo, useRef, useState, type CSSProperties } from "react";
import type {
  TimelineConversationAttachments,
  TimelineRowBase,
  TimelineUserConversationRow,
} from "@bb/server-contract";
import type { PromptTextMention } from "@bb/domain";
import {
  boundedMarkdownPreview,
  closeUnterminatedMarkdownCodeSpan,
  computeMutedPrefixLength,
  turnRequestLabel,
  USER_MESSAGE_CHAR_CAP,
} from "@bb/client-core";
import { cn } from "@bb/shared-ui/lib/utils";
import { MarkdownPreview } from "@bb/app-kit/components/ui/markdown-preview";
import type { MarkdownLinkRouting } from "@bb/app-kit/components/ui/markdown-link-routing";
import {
  parseLocalFileHref,
  resolveRelativeLocalFileHref,
} from "@bb/app-kit/components/ui/markdown-local-file-link";
import {
  useMessageDirectiveRegistry,
  type MarkdownMessageDirectives,
} from "@bb/app-kit/components/ui/markdown-message-directives";
import { buildThreadHostFileContentUrl } from "@bb/app-kit/lib/file-content-urls";
import type { MarkdownThreadMentions } from "@bb/app-kit/components/ui/markdown-thread-mentions";
import {
  ConversationAttachments,
  buildAttachmentItems,
} from "./ConversationAttachments";
import { GeneratedConversationMessage } from "./GeneratedConversationMessage";
import { clipMentionTextToVisibleRange } from "@bb/app-kit/components/thread/timeline/ConversationMessageMentions";
import {
  repairStreamingMarkdownTail,
  splitStreamingMarkdown,
} from "./streaming-markdown-split";
import { TurnRequestLabel } from "./TurnRequestLabel";
import { MessageActionBar, PROSE_COLUMN_INSET_CLASS } from "./MessageActionBar";
import {
  ConversationMessageOverflowToggle,
  useIsOverflowing,
} from "./conversation-message-overflow";
import { useTimeline } from "./timeline-context";
import {
  UserAttributionLabel,
  useUserAttribution,
} from "@bb/app-kit/components/users/user-attribution";

const COLLAPSED_MESSAGE_FADE_STYLE: CSSProperties = {
  maskImage:
    "linear-gradient(to bottom, black calc(100% - 2.5rem), transparent)",
  WebkitMaskImage:
    "linear-gradient(to bottom, black calc(100% - 2.5rem), transparent)",
};

const ASSISTANT_THREAD_MENTIONS: MarkdownThreadMentions = {
  mentions: [],
  preserveSoftBreaks: false,
};

const STREAMING_SETTLED_MARKDOWN_CLASS_NAME = "[&>p:last-child]:mb-2";
const STREAMING_TAIL_MARKDOWN_CLASS_NAME =
  "[&>h1:first-child]:mt-4 [&>h2:first-child]:mt-4 [&>h3:first-child]:mt-3 [&>h4:first-child]:mt-3 [&>h5:first-child]:mt-2 [&>h6:first-child]:mt-2";

export function useMessageLinkRouting(
  threadId: string | undefined,
): MarkdownLinkRouting {
  const { onOpenLink, onOpenLocalFileLink, workspaceRootPath } = useTimeline();
  return useMemo(() => {
    const relative =
      workspaceRootPath === undefined
        ? undefined
        : { baseDir: workspaceRootPath, rootPath: workspaceRootPath };
    return {
      onOpenLink,
      localImage:
        threadId === undefined
          ? undefined
          : {
              absolutePaths: { kind: "trusted-host" },
              relativePaths: relative,
              resolveSrc: ({ path }) =>
                buildThreadHostFileContentUrl(threadId, path),
            },
      localFile:
        onOpenLocalFileLink === undefined
          ? undefined
          : {
              absoluteLinks: { kind: "trusted-host" },
              onOpenLink: onOpenLocalFileLink,
              relativeLinks: relative,
            },
    };
  }, [onOpenLink, onOpenLocalFileLink, threadId, workspaceRootPath]);
}

function CollapsibleMessageText({
  linkRouting,
  mentions,
  text,
  mutePrefixLength,
}: {
  linkRouting?: MarkdownLinkRouting;
  mentions: readonly PromptTextMention[];
  text: string;
  mutePrefixLength: number;
}) {
  const { resolveMentionLink, resolveSegmentLinkHref } = useTimeline();
  const bodyOffset =
    mutePrefixLength > 0 && mutePrefixLength < text.length
      ? mutePrefixLength
      : 0;
  const prefixText = bodyOffset > 0 ? text.slice(0, bodyOffset) : null;
  const bodyText = text.slice(bodyOffset);

  const [isExpanded, setIsExpanded] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const exceedsCollapsedRenderCap = bodyText.length > USER_MESSAGE_CHAR_CAP;
  const collapsedPreview =
    !isExpanded && exceedsCollapsedRenderCap
      ? boundedMarkdownPreview(bodyText, USER_MESSAGE_CHAR_CAP)
      : null;
  const renderedBodyText = collapsedPreview?.text ?? bodyText;
  const body = useMemo(
    () =>
      clipMentionTextToVisibleRange({
        mentions,
        rangeStart: bodyOffset,
        text: renderedBodyText,
      }),
    [mentions, bodyOffset, renderedBodyText],
  );
  const promptMentions = useMemo(
    () => ({
      mentions: body.mentions,
      resolveLinkHref: resolveSegmentLinkHref,
      resolveMentionLink,
    }),
    [body.mentions, resolveSegmentLinkHref, resolveMentionLink],
  );
  const rawThreadMentions = useMemo<MarkdownThreadMentions>(
    () => ({ mentions: body.mentions, preserveSoftBreaks: true }),
    [body.mentions],
  );
  const isOverflowing = useIsOverflowing({
    elementRef: bodyRef,
    enabled: !isExpanded,
    measurementKey: body.text,
  });
  const showToggle = isExpanded || exceedsCollapsedRenderCap || isOverflowing;

  return (
    <>
      {prefixText !== null ? (
        <span
          className="line-clamp-1 text-muted-foreground"
          title={prefixText.trimEnd()}
        >
          {prefixText}
        </span>
      ) : null}
      <div
        ref={bodyRef}
        data-image-gallery-clipped={!isExpanded ? "" : undefined}
        className={cn(
          "break-words",
          !isExpanded && "max-h-[15lh] overflow-hidden",
        )}
        style={
          !isExpanded && showToggle ? COLLAPSED_MESSAGE_FADE_STYLE : undefined
        }
      >
        {collapsedPreview?.parseAsMarkdown === false ? (
          <span>{body.text}</span>
        ) : (
          <MarkdownPreview
            content={
              collapsedPreview?.wasCapped === true
                ? closeUnterminatedMarkdownCodeSpan(body.text)
                : body.text
            }
            promptMentions={promptMentions}
            threadMentions={rawThreadMentions}
            linkRouting={linkRouting}
          />
        )}
      </div>
      {showToggle ? (
        <ConversationMessageOverflowToggle
          expanded={isExpanded}
          onToggle={() => setIsExpanded((prev) => !prev)}
        />
      ) : null}
    </>
  );
}

export function UserConversationMessage({
  row,
}: {
  row: TimelineUserConversationRow;
}) {
  const { latestActionableUserMessageId, onMessageAddToChat, projectId } =
    useTimeline();
  const linkRouting = useMessageLinkRouting(row.threadId);
  const attachmentItems = useMemo(
    () => buildAttachmentItems(row.attachments, projectId),
    [row.attachments, projectId],
  );
  const sender = useUserAttribution(
    row.initiator === "user" ? row.actorUserId : null,
  );
  if (
    row.initiator === "system" ||
    (row.initiator === "agent" && row.senderThreadId !== null)
  ) {
    return (
      <GeneratedConversationMessage
        attachmentItems={attachmentItems}
        linkRouting={linkRouting}
        row={row}
      />
    );
  }

  const messageText = row.text.trim();
  return (
    <div className="w-full">
      <div className="group/message ml-auto flex w-fit max-w-[70%] flex-col items-end">
        {sender !== null || turnRequestLabel(row.turnRequest) ? (
          <div className="mb-1 flex max-w-full items-center justify-end gap-2">
            {sender === null ? null : (
              <UserAttributionLabel attribution={sender} />
            )}
            <TurnRequestLabel
              turnRequest={row.turnRequest}
              icon="ArrowTurnForward"
            />
          </div>
        ) : null}
        <div className="flex w-fit max-w-full flex-col items-end">
          <div className="max-w-full rounded-xl border border-border-seam bg-surface-recessed px-4 py-2.5 text-sm leading-relaxed text-foreground">
            {messageText ? (
              <CollapsibleMessageText
                mentions={row.mentions}
                linkRouting={linkRouting}
                text={row.text}
                mutePrefixLength={computeMutedPrefixLength(
                  row.initiator,
                  row.text,
                )}
              />
            ) : (
              <p className="text-muted-foreground">Sent attachments</p>
            )}
            <ConversationAttachments
              align="end"
              filePaths={attachmentItems.filePaths}
              imageItems={attachmentItems.imageItems}
            />
          </div>
          <MessageActionBar
            messageText={messageText}
            alignment="end"
            mobileActionDisplay={
              row.id === latestActionableUserMessageId ? "inline" : "overflow"
            }
            addToChatAttachments={attachmentItems.draftAttachments}
            copyImageUrl={attachmentItems.imageItems[0]?.src}
            onAddToChat={onMessageAddToChat}
          />
        </div>
      </div>
    </div>
  );
}

export function AssistantConversationMessage({
  attachments,
  id,
  showActions,
  streaming,
  text,
  threadId,
  turnId,
}: Pick<TimelineRowBase, "id" | "threadId" | "turnId"> & {
  attachments: TimelineConversationAttachments | null;
  showActions: boolean;
  streaming: boolean;
  text: string;
}) {
  const {
    latestActionableAssistantMessageId,
    onMessageAddToChat,
    onOpenLocalFileLink,
    onOpenPluginPanel,
    projectId,
    workspaceRootPath,
  } = useTimeline();
  const attachmentItems = useMemo(
    () => buildAttachmentItems(attachments, projectId),
    [attachments, projectId],
  );
  const streamingSplit = useMemo(
    () => (streaming ? splitStreamingMarkdown(text) : null),
    [streaming, text],
  );
  const liveMarkdown = useMemo(() => {
    const tail = streamingSplit?.tail ?? text;
    return streaming ? repairStreamingMarkdownTail(tail) : tail;
  }, [streaming, streamingSplit, text]);
  const linkRouting = useMessageLinkRouting(threadId);
  const registry = useMessageDirectiveRegistry();
  const messageDirectives = useMemo<
    MarkdownMessageDirectives | undefined
  >(() => {
    if (registry.size === 0) {
      return undefined;
    }
    return {
      registry,
      message: { id, threadId, turnId, projectId: projectId ?? null },
      openWorkspaceFile:
        onOpenLocalFileLink === undefined || workspaceRootPath === undefined
          ? null
          : (path) => {
              const href = resolveRelativeLocalFileHref({
                baseDir: workspaceRootPath,
                href: path,
                rootPath: workspaceRootPath,
              });
              const link =
                href === null
                  ? null
                  : parseLocalFileHref({
                      absoluteLinks: {
                        kind: "contained",
                        rootPath: workspaceRootPath,
                      },
                      href,
                    });
              return link === null ? false : onOpenLocalFileLink(link);
            },
      openThreadPanel: onOpenPluginPanel ?? null,
    };
  }, [
    registry,
    id,
    threadId,
    turnId,
    projectId,
    onOpenLocalFileLink,
    workspaceRootPath,
    onOpenPluginPanel,
  ]);

  return (
    <div
      className={cn(
        "group/message w-full text-sm font-normal leading-relaxed",
        PROSE_COLUMN_INSET_CLASS,
      )}
    >
      <div data-sidebar-swipe-selectable>
        <MarkdownPreview
          allowHtml
          className={
            streamingSplit === null
              ? undefined
              : STREAMING_SETTLED_MARKDOWN_CLASS_NAME
          }
          content={
            streamingSplit === null ? liveMarkdown : streamingSplit.settled
          }
          incrementalBlocks
          linkRouting={linkRouting}
          messageDirectives={messageDirectives}
          threadMentions={ASSISTANT_THREAD_MENTIONS}
        />
        {streamingSplit === null ? null : (
          <MarkdownPreview
            allowHtml
            className={STREAMING_TAIL_MARKDOWN_CLASS_NAME}
            content={liveMarkdown}
            sourcePrefix={streamingSplit.settled}
            incrementalBlocks
            linkRouting={linkRouting}
            messageDirectives={messageDirectives}
            threadMentions={ASSISTANT_THREAD_MENTIONS}
          />
        )}
      </div>
      <ConversationAttachments
        filePaths={attachmentItems.filePaths}
        imageItems={attachmentItems.imageItems}
      />
      {showActions ? (
        <MessageActionBar
          messageText={text}
          alignment="start"
          mobileActionDisplay={
            id === latestActionableAssistantMessageId ? "inline" : "overflow"
          }
          addToChatAttachments={attachmentItems.draftAttachments}
          copyImageUrl={attachmentItems.imageItems[0]?.src}
          onAddToChat={onMessageAddToChat}
        />
      ) : null}
    </div>
  );
}
