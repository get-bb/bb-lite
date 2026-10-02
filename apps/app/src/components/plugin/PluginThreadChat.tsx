import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { appendQuoteAndAttachmentsToDraft } from "@bb/client-core";
import { formatEnvironmentDisplay } from "@bb/core-ui";
import { defaultAppSettings } from "@bb/domain";
import type { ThreadChatProps } from "@bb/plugin/app";
import type { ThreadResponse } from "@bb/server-contract";
import { EmptyStatePanel } from "@bb/shared-ui/empty-state";
import { cn } from "@bb/shared-ui/lib/utils";
import { Skeleton } from "@bb/shared-ui/skeleton";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import {
  ThreadTimelinePanelContent,
  type ThreadTimelineAddToChatHandler,
} from "@/components/thread/timeline";
import { useThreadTimelineNavigation } from "@/components/thread/timeline/ThreadTimelineNavigationContext";
import { BottomAnchoredScrollBody } from "@/components/ui/bottom-anchored-scroll-body";
import { OverflowFade } from "@/components/ui/overflow-fade";
import { useSendThreadMessage } from "@/hooks/mutations/thread-runtime-mutations";
import { useMarkThreadRead } from "@/hooks/mutations/thread-state-mutations";
import { useSystemEnvironmentProviders } from "@/hooks/queries/environment-provider-queries";
import { useEnvironment } from "@/hooks/queries/environment-queries";
import { useHosts } from "@/hooks/queries/host-queries";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import {
  isPendingInteractionStateUnknown,
  useThread,
  useThreadPendingInteractions,
} from "@/hooks/queries/thread-queries";
import { useLocalHostId } from "@/hooks/useOpenTargets";
import { getPromptDraftAccessor } from "@/hooks/usePromptDraftStorage";
import { useThreadReadTracking } from "@/hooks/useThreadReadTracking";
import {
  findEnvironmentDisplayProvider,
  getEnvironmentSummaryChrome,
} from "@/lib/environment-workspace-display";
import {
  getProjectComposeRoutePath,
  getThreadRoutePath,
} from "@/lib/route-paths";
import { BbHttpError } from "@/lib/sdk";
import { formatWorkspaceCheckoutDisplay } from "@/lib/workspace-checkout-display";
import { ThreadDetailPromptArea } from "@/views/thread-detail/ThreadDetailPromptArea";

const NOTHING: never[] = [];

export function PluginThreadChat({
  threadId,
  variant = "full",
  layout = "contained",
  focusRequest,
  className,
  leadingContent,
}: ThreadChatProps) {
  const navigate = useNavigate();
  const threadQuery = useThread(threadId, { enabled: threadId.length > 0 });
  const thread = threadQuery.data;
  const environment = useEnvironment(thread?.environmentId ?? null).data;
  const hostNavigation = useThreadTimelineNavigation();
  const navigation =
    thread !== undefined &&
    thread.environmentId === hostNavigation?.environmentId
      ? hostNavigation
      : null;
  const resolveMentionLink: PromptMentionLinkResolver = (resource) => {
    if (resource.kind === "thread") {
      const projectId = resource.projectId ?? thread?.projectId;
      return projectId === undefined
        ? null
        : () =>
            navigate(
              getThreadRoutePath({ projectId, threadId: resource.threadId }),
            );
    }
    if (resource.kind === "project") {
      return () => navigate(getProjectComposeRoutePath(resource.projectId));
    }
    return resource.kind === "path" &&
      resource.entryKind === "file" &&
      resource.source === "workspace"
      ? (navigation?.resolveMentionLink?.(resource) ?? null)
      : null;
  };
  const contained = layout === "contained";
  const timeline = (
    onAddToChat?: ThreadTimelineAddToChatHandler,
    isTurnSubmitting?: boolean,
  ) =>
    thread && (
      <ThreadTimelinePanelContent
        isTurnSubmitting={isTurnSubmitting}
        leadingContent={leadingContent}
        onOpenLink={hostNavigation?.onOpenLink}
        onOpenLocalFileLink={navigation?.onOpenLocalFileLink}
        onMessageAddToChat={onAddToChat}
        projectId={thread.projectId}
        resolveMentionLink={resolveMentionLink}
        surfaceKey={onAddToChat ? undefined : `plugin-thread-chat:${threadId}`}
        threadId={threadId}
        workspaceRootPath={environment?.path ?? navigation?.workspaceRootPath}
      />
    );
  return (
    <div
      className={cn(
        contained ? "flex h-full min-h-0 flex-col" : "flex flex-col",
        className,
      )}
    >
      {threadQuery.error instanceof BbHttpError &&
      threadQuery.error.status === 404 ? (
        <EmptyStatePanel className="m-2 rounded-lg">
          This thread is no longer available.
        </EmptyStatePanel>
      ) : thread === undefined ? (
        <div className="space-y-2 px-4 pt-4">
          <Skeleton className="h-4 w-3/4 rounded-sm" />
          <Skeleton className="h-4 w-2/3 rounded-sm" />
          <Skeleton className="h-4 w-1/2 rounded-sm" />
        </div>
      ) : variant === "timeline" ? (
        <div
          className={cn(
            "bg-background px-2 pb-3 pt-3",
            contained && "min-h-0 flex-1 overflow-y-auto",
          )}
        >
          {timeline()}
        </div>
      ) : (
        <ThreadChatWithComposer
          key={threadId}
          thread={thread}
          contained={contained}
          page={variant === "full"}
          focusRequest={focusRequest ?? 0}
          resolveMentionLink={resolveMentionLink}
          timeline={timeline}
        />
      )}
    </div>
  );
}

function ThreadChatWithComposer({
  thread,
  contained,
  page,
  focusRequest,
  resolveMentionLink,
  timeline,
}: {
  thread: ThreadResponse;
  contained: boolean;
  page: boolean;
  focusRequest: number;
  resolveMentionLink: PromptMentionLinkResolver;
  timeline: (
    onAddToChat: ThreadTimelineAddToChatHandler,
    isTurnSubmitting: boolean,
  ) => ReactNode;
}) {
  const settings = useSystemConfig().data?.generalSettings;
  const sendMessage = useSendThreadMessage();
  const markThreadRead = useMarkThreadRead();
  const pending = useThreadPendingInteractions(thread.id);
  const environment = useEnvironment(thread.environmentId).data;
  const hosts = useHosts({ enabled: environment !== undefined }).data;
  const localHostId = useLocalHostId();
  const { providers } = useSystemEnvironmentProviders();
  const [focusNonce, setFocusNonce] = useState(0);
  useThreadReadTracking({ markThreadRead, thread });
  const providerLookup = findEnvironmentDisplayProvider(
    providers,
    environment?.environmentProviderId ?? null,
  );
  const chrome = environment
    ? getEnvironmentSummaryChrome({
        display: formatEnvironmentDisplay({
          environment,
          host: {
            locality: environment.hostId === localHostId ? "local" : "remote",
            identity: null,
          },
          providerLookup,
        }),
        providerLookup,
        hasMultipleMachines: (hosts?.length ?? 0) > 1,
        host: hosts?.find((host) => host.id === environment.hostId) ?? null,
      })
    : undefined;
  const addToChat: ThreadTimelineAddToChatHandler = (text, attachments) => {
    const draft = getPromptDraftAccessor({
      kind: "thread",
      projectId: thread.projectId,
      threadId: thread.id,
    });
    draft.setDraft(
      appendQuoteAndAttachmentsToDraft(
        draft.getCurrent(),
        text,
        attachments ?? [],
      ),
    );
    setFocusNonce((nonce) => nonce + 1);
  };
  const tone = page ? "background" : "sidebar";
  const surfaceClassName = page ? "bg-background" : "bg-sidebar";
  const footer = (
    <div className={cn("relative", surfaceClassName)}>
      <OverflowFade placement="above" tone={tone} />
      <div className="px-4 pb-4 pt-2">
        <ThreadDetailPromptArea
          thread={thread}
          projectId={thread.projectId}
          resolveMentionLink={resolveMentionLink}
          sendMessage={sendMessage}
          steerActiveThreadOnEnter={
            settings?.steerActiveThreadOnEnter ??
            defaultAppSettings.steerActiveThreadOnEnter
          }
          composerFocusRequestNonce={focusNonce + focusRequest}
          pendingInteractions={pending.data ?? NOTHING}
          pendingInteractionsInitialLoading={isPendingInteractionStateUnknown(
            pending.data,
            pending.isFetching,
          )}
          environmentGoneStatus={null}
          environmentHostId={environment?.hostId}
          environmentCheckout={
            environment?.branchName
              ? formatWorkspaceCheckoutDisplay({
                  checkout: {
                    kind: "branch",
                    branchName: environment.branchName,
                    headSha: null,
                  },
                })
              : undefined
          }
          {...chrome}
          canUseGitUi={false}
          onChangedFileClick={() => {}}
          workspaceChangedFilesSection={null}
          workspaceStatusPending={false}
          contextBannerMergeBase={null}
          pendingTodos={null}
          modelFallback={null}
          activeWorkflows={NOTHING}
          activeBackgroundCommands={NOTHING}
          parentThreadSection={null}
          childPendingInteractions={NOTHING}
          childThreadsSection={null}
        />
      </div>
    </div>
  );
  const maxWidthClassName = page ? "max-w-[760px]" : "max-w-none";
  if (!contained) {
    return (
      <div
        data-thread-window=""
        data-surface-tone={tone}
        className={cn("flex min-w-0 flex-col", surfaceClassName)}
      >
        <div
          className={cn(
            "mx-auto flex w-full min-w-0 flex-col pb-3 pt-3",
            page ? "px-4" : "px-2",
            maxWidthClassName,
          )}
        >
          {timeline(addToChat, sendMessage.isPending)}
        </div>
        <div className="sticky bottom-0 z-20">{footer}</div>
      </div>
    );
  }
  return (
    <div
      data-thread-window=""
      data-surface-tone={tone}
      className="flex min-h-0 flex-1 flex-col"
    >
      <BottomAnchoredScrollBody
        scrollAreaClassName={surfaceClassName}
        contentClassName={page ? "!pb-3 !pt-3" : "!px-2 !pb-3 !pt-3"}
        maxWidthClassName={maxWidthClassName}
        footer={footer}
      >
        {timeline(addToChat, sendMessage.isPending)}
      </BottomAnchoredScrollBody>
    </div>
  );
}
