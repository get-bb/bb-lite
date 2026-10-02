import { useMemo, useRef } from "react";
import type { TimelineUserConversationRow } from "@bb/server-contract";
import type { SystemMessageKind } from "@bb/domain";
import type { TimelineTitle, TimelineTitleSegment } from "@bb/thread-view";
import {
  boundedMarkdownPreview,
  closeUnterminatedMarkdownCodeSpan,
  computeMutedPrefixLength,
  endsInsideExactRawThreadIdCodeSpan,
  GENERATED_MESSAGE_COLLAPSED_PREVIEW_CHAR_CAP,
  turnRequestLabel,
} from "@bb/client-core";
import { type IconName } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { MarkdownPreview } from "@/components/ui/markdown-preview.js";
import type { MarkdownLinkRouting } from "@/components/ui/markdown-link-routing.js";
import { useThreadTitleDisplayText } from "@/components/thread/ThreadTitleMentions.js";
import { getThreadRoutePath } from "@/lib/route-paths";
import {
  ConversationAttachments,
  type ConversationAttachmentItems,
} from "./ConversationAttachments.js";
import {
  clipMentionTextToVisibleRange,
  PromptMentionPill,
  shiftMentionsToTextRange,
} from "./ConversationMessageMentions.js";
import { ExpandableTimelineRow } from "./ExpandableTimelineRow.js";
import { NESTED_TIMELINE_GROUP_LINE_CLASS_NAME } from "./timeline-nested-group-line.js";
import { TurnRequestLabel } from "./TurnRequestLabel.js";
import { useOverflowMeasurement } from "./conversation-message-overflow.js";
import { useTimeline } from "./timeline-context.js";

const SYSTEM_MESSAGE_VERBS: Partial<Record<SystemMessageKind, string>> = {
  "ownership-assigned": "assigned to you",
  "ownership-removed": "unassigned",
  "child-needs-attention": "needs attention",
  "child-completed": "finished",
  "child-failed": "failed",
  "child-interrupted": "was interrupted",
};

const SYSTEM_MESSAGE_ICONS: Record<SystemMessageKind, IconName> = {
  "ownership-assigned": "UserRoundPlus",
  "ownership-removed": "UserRound",
  "child-needs-attention": "AlertTriangle",
  "child-completed": "CircleCheck",
  "child-failed": "CircleX",
  "child-interrupted": "AlertCircle",
  "child-outcome-batch": "ListTodo",
  "tool-result-delivered": "Toolbox",
  unlabeled: "Info",
};

const COLLAPSED_MARKDOWN_PREVIEW_CLASS = cn(
  "[&_p]:!m-0 [&_p]:inline",
  "[&_ul]:!m-0 [&_ol]:!m-0 [&_ul]:!pl-0 [&_ol]:!pl-0 [&_li]:!m-0 [&_li]:inline",
  "[&_h1]:!m-0 [&_h2]:!m-0 [&_h3]:!m-0 [&_h4]:!m-0",
  "[&_h1]:inline [&_h2]:inline [&_h3]:inline [&_h4]:inline",
  "[&_h1]:!text-sm [&_h2]:!text-sm [&_h3]:!text-sm [&_h4]:!text-sm",
  "[&_pre]:!m-0 [&_pre]:!inline [&_pre]:!bg-transparent [&_pre]:!p-0 [&_pre]:!border-0",
  "[&_blockquote]:!m-0 [&_blockquote]:inline [&_blockquote]:!border-0 [&_blockquote]:!pl-0",
);

function verb(text: string, truncate = false): TimelineTitleSegment {
  return { em: false, shimmer: false, text, truncate };
}

function subject(text: string, threadId: string | null): TimelineTitleSegment {
  return {
    em: true,
    shimmer: false,
    text,
    truncate: true,
    ...(threadId === null
      ? {}
      : { link: { kind: "thread" as const, threadId } }),
  };
}

function systemMessageSegments(
  row: TimelineUserConversationRow,
): TimelineTitleSegment[] {
  const { systemMessageKind: kind, systemMessageSubject: about } = row;
  const threadVerb = SYSTEM_MESSAGE_VERBS[kind];
  if (threadVerb !== undefined && about?.kind === "thread") {
    return [subject(about.threadName, about.threadId), verb(threadVerb)];
  }
  if (kind === "child-outcome-batch" && about?.kind === "thread-batch") {
    return [verb(`${about.count} threads updated`)];
  }
  if (kind === "tool-result-delivered" && about?.kind === "tool-call") {
    return [verb("Delivered"), subject(about.toolName, null), verb("result")];
  }
  return [verb("System Message", true)];
}

function collapsedPreviewSource(text: string) {
  const previewWindow = text.slice(
    0,
    GENERATED_MESSAGE_COLLAPSED_PREVIEW_CHAR_CAP + 1,
  );
  const lineBreak = /\r\n|\r|\n/u.exec(previewWindow);
  if (lineBreak === null) {
    return {
      hasAdditionalBodyLines: false,
      ...boundedMarkdownPreview(
        text,
        GENERATED_MESSAGE_COLLAPSED_PREVIEW_CHAR_CAP,
      ),
    };
  }
  const firstLine = previewWindow.slice(0, lineBreak.index);
  return {
    hasAdditionalBodyLines: true,
    parseAsMarkdown: !endsInsideExactRawThreadIdCodeSpan(firstLine),
    text: firstLine,
    wasCapped: false,
  };
}

function AgentSourceTitle({
  leadIn,
  sourceName,
  sourceProjectId,
  sourceThreadId,
}: {
  leadIn: string;
  sourceName: string;
  sourceProjectId: string | null;
  sourceThreadId: string;
}) {
  const { resolveSegmentLinkHref } = useTimeline();
  const sourceDisplayName = useThreadTitleDisplayText(sourceName);
  const linkHref =
    sourceProjectId !== null
      ? getThreadRoutePath({
          projectId: sourceProjectId,
          threadId: sourceThreadId,
        })
      : resolveSegmentLinkHref({ kind: "thread", threadId: sourceThreadId });
  return (
    <span
      className="inline-flex min-w-0 max-w-full items-center gap-1 overflow-hidden whitespace-nowrap text-sm leading-5"
      title={`${leadIn} ${sourceDisplayName}`}
    >
      <span className="shrink-0 whitespace-pre text-muted-foreground">
        {leadIn}
      </span>{" "}
      <PromptMentionPill
        resource={{
          kind: "thread",
          threadId: sourceThreadId,
          ...(sourceProjectId === null ? {} : { projectId: sourceProjectId }),
          label: sourceDisplayName,
        }}
        serializedText={`@thread:${sourceThreadId}`}
        linkHref={linkHref ?? undefined}
      />
    </span>
  );
}

export function GeneratedConversationMessage({
  attachmentItems,
  linkRouting,
  row,
}: {
  attachmentItems: ConversationAttachmentItems;
  linkRouting: MarkdownLinkRouting | undefined;
  row: TimelineUserConversationRow;
}) {
  const {
    onTitleAction,
    resolveMentionLink,
    resolveSegmentLinkHref,
    senderThreads,
    threadOriginKind,
  } = useTimeline();
  const { senderThreadId, systemMessageKind, turnRequest } = row;
  const isAgent = row.initiator === "agent" && senderThreadId !== null;
  const sender = isAgent ? senderThreads.get(senderThreadId) : undefined;
  const isFork =
    isAgent && row.turnId === null && (threadOriginKind ?? null) === "fork";
  const leadIn = isFork ? "Forked from" : "Message from";
  const sourceName = sender?.title ?? "Agent";

  const prefixLength = Math.max(
    0,
    computeMutedPrefixLength(row.initiator, row.text),
  );
  const bodyText = row.text.slice(prefixLength);
  const messageText = bodyText.trim();
  const bodyStart =
    prefixLength + bodyText.length - bodyText.trimStart().length;
  const messageMentions = useMemo(
    () =>
      shiftMentionsToTextRange({
        mentions: row.mentions,
        rangeStart: bodyStart,
        rangeEnd: bodyStart + messageText.length,
      }),
    [row.mentions, bodyStart, messageText.length],
  );
  const title = useMemo<TimelineTitle>(() => {
    const segments = isAgent
      ? [verb(leadIn), subject(sourceName, senderThreadId)]
      : systemMessageSegments(row);
    return {
      action: null,
      decorations: [],
      plain: segments
        .map((segment) => segment.plainText ?? segment.text)
        .join(" "),
      segments,
      tone: "default",
    };
  }, [isAgent, leadIn, sourceName, senderThreadId, row]);

  const titleOnly =
    !isAgent &&
    (systemMessageKind === "ownership-assigned" ||
      systemMessageKind === "ownership-removed");
  const requestLabel = turnRequestLabel(turnRequest);
  const preview = collapsedPreviewSource(messageText);
  const previewTextRef = useRef<HTMLDivElement>(null);
  const previewOverflow = useOverflowMeasurement({
    elementRef: previewTextRef,
    enabled: !titleOnly && messageText.length > 0,
    measurementKey: messageText,
  });
  const expandable =
    !titleOnly &&
    (attachmentItems.filePaths.length > 0 ||
      attachmentItems.imageItems.length > 0 ||
      requestLabel !== null ||
      preview.hasAdditionalBodyLines ||
      preview.wasCapped ||
      previewOverflow === "overflowing");
  const previewBody = useMemo(
    () =>
      clipMentionTextToVisibleRange({
        mentions: messageMentions,
        rangeStart: 0,
        text: preview.text,
      }),
    [messageMentions, preview.text],
  );
  const imagePolicy = isAgent ? "alt-text" : "render";
  const previewMentions = useMemo(
    () => ({
      mentions: previewBody.mentions,
      preserveSoftBreaks: true,
      resolveLinkHref: resolveSegmentLinkHref,
      resolveMentionLink,
    }),
    [previewBody.mentions, resolveSegmentLinkHref, resolveMentionLink],
  );
  const bodyMentions = useMemo(
    () => ({
      mentions: messageMentions,
      preserveSoftBreaks: true,
      resolveLinkHref: resolveSegmentLinkHref,
      resolveMentionLink,
    }),
    [messageMentions, resolveSegmentLinkHref, resolveMentionLink],
  );

  const collapsedPreview =
    !titleOnly && previewBody.text ? (
      <div
        className={`${NESTED_TIMELINE_GROUP_LINE_CLASS_NAME} max-w-full min-w-0`}
      >
        <div className="flex min-w-0 items-baseline truncate pl-2 text-sm leading-relaxed text-foreground">
          <div ref={previewTextRef} className="min-w-0 truncate">
            {preview.parseAsMarkdown ? (
              <MarkdownPreview
                allowHtml
                content={
                  preview.wasCapped || preview.hasAdditionalBodyLines
                    ? closeUnterminatedMarkdownCodeSpan(previewBody.text)
                    : previewBody.text
                }
                imagePolicy={imagePolicy}
                linkRouting={linkRouting}
                promptMentions={previewMentions}
                threadMentions={previewMentions}
                className={COLLAPSED_MARKDOWN_PREVIEW_CLASS}
              />
            ) : (
              <span>{previewBody.text}</span>
            )}
          </div>
          {expandable ? (
            <span
              className={cn(
                "shrink-0 text-muted-foreground",
                previewOverflow === "overflowing" && "invisible",
              )}
            >
              ...
            </span>
          ) : null}
        </div>
      </div>
    ) : null;

  return (
    <ExpandableTimelineRow
      title={title}
      titleContent={
        isAgent ? (
          <AgentSourceTitle
            leadIn={leadIn}
            sourceName={sourceName}
            sourceProjectId={sender?.projectId ?? null}
            sourceThreadId={senderThreadId}
          />
        ) : undefined
      }
      collapsedPreview={collapsedPreview}
      expandable={expandable}
      leadingIcon={
        isFork
          ? "Fork"
          : isAgent
            ? "MessageSquare"
            : SYSTEM_MESSAGE_ICONS[systemMessageKind]
      }
      resolveSegmentLinkHref={resolveSegmentLinkHref}
      onTitleAction={onTitleAction}
      renderBody={() => (
        <div className={NESTED_TIMELINE_GROUP_LINE_CLASS_NAME}>
          <div className="pl-2 text-sm leading-relaxed text-foreground">
            {messageText ? (
              <MarkdownPreview
                allowHtml
                content={messageText}
                imagePolicy={imagePolicy}
                linkRouting={linkRouting}
                promptMentions={bodyMentions}
                threadMentions={bodyMentions}
              />
            ) : (
              <p className="text-muted-foreground">
                {isAgent ? "Sent an agent message" : "Sent a BB system message"}
              </p>
            )}
            <ConversationAttachments
              align="start"
              filePaths={attachmentItems.filePaths}
              imageItems={attachmentItems.imageItems}
            />
            {requestLabel ? (
              <div className="mt-1 flex items-center justify-start gap-2">
                <TurnRequestLabel turnRequest={turnRequest} />
              </div>
            ) : null}
          </div>
        </div>
      )}
    />
  );
}
