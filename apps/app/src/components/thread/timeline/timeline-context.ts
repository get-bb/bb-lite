import { createContext, useContext } from "react";
import type { ThreadOriginKind } from "@bb/domain";
import type { PromptDraftAttachment } from "@bb/client-core";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import type { MarkdownPreviewLinkHandler } from "@/components/ui/markdown-link.js";
import type {
  MarkdownPreviewLocalFileLink,
  MarkdownPreviewLocalFileLinkHandler,
} from "@/components/ui/markdown-local-file-link.js";
import type { MarkdownMessageDirectiveOpenThreadPanel } from "@/components/ui/markdown-message-directives";
import type { SenderThreadMetadata } from "@/hooks/useSenderThreadMetadataById";
import type {
  TimelineTitleActionResolver,
  TimelineTitleLinkResolver,
} from "./TimelineTitleView.js";

export type ThreadTimelineLocalFileLink = MarkdownPreviewLocalFileLink;
export type ThreadTimelineLocalFileLinkHandler =
  MarkdownPreviewLocalFileLinkHandler;
export type ThreadTimelineLinkHandler = MarkdownPreviewLinkHandler;
export type ThreadTimelineOpenPluginPanelHandler =
  MarkdownMessageDirectiveOpenThreadPanel;
export type ThreadTimelineAddToChatHandler = (
  text: string,
  attachments?: readonly PromptDraftAttachment[],
) => void;
export type ThreadTimelineUnreadDividerPlacement =
  | { kind: "after-cutoff"; cutoffAt: number }
  | { kind: "before-first" };

export interface TimelineHandlers {
  onMessageAddToChat?: ThreadTimelineAddToChatHandler;
  onOpenLink?: ThreadTimelineLinkHandler;
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
  onOpenPluginPanel?: ThreadTimelineOpenPluginPanelHandler;
  onTitleAction?: TimelineTitleActionResolver;
  projectId?: string;
  resolveMentionLink?: PromptMentionLinkResolver;
  threadOriginKind?: ThreadOriginKind | null;
  workspaceRootPath: string | undefined;
}

export interface TimelineContextValue extends TimelineHandlers {
  liveExpandedRowIds: ReadonlySet<string>;
  resolveSegmentLinkHref: TimelineTitleLinkResolver;
  senderThreads: ReadonlyMap<string, SenderThreadMetadata>;
  streamingMessageId: string | null;
  terminalExpandedRowIds: ReadonlySet<string>;
  threadId: string | undefined;
}

export const TimelineContext = createContext<TimelineContextValue | null>(null);

export function useTimeline(): TimelineContextValue {
  const context = useContext(TimelineContext);
  if (!context) {
    throw new Error("Thread timeline context is missing");
  }
  return context;
}
