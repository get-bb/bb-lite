import { useCallback, useMemo, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { ThreadChatProps } from "@bb/plugin/app";
import {
  formatEnvironmentDisplay,
  type EnvironmentDisplayHostContext,
} from "@bb/core-ui";
import { EmptyStatePanel } from "@bb/shared-ui/empty-state";
import { Skeleton } from "@bb/shared-ui/skeleton";
import { cn } from "@bb/shared-ui/lib/utils";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import { ThreadEnvironmentSummary } from "@/components/promptbox/ThreadEnvironmentSummary";
import { EmbeddedThreadChat } from "@/components/thread/embedded-chat";
import { ThreadTimelinePanelContent } from "@/components/thread/timeline";
import { useThreadTimelineNavigation } from "@/components/thread/timeline/ThreadTimelineNavigationContext";
import { useEnvironment } from "@/hooks/queries/environment-queries";
import { useThread } from "@/hooks/queries/thread-queries";
import { useLocalHostId } from "@/hooks/useOpenTargets";
import { useHosts } from "@/hooks/queries/host-queries";
import {
  findEnvironmentDisplayProvider,
  getEnvironmentSummaryChrome,
} from "@/lib/environment-workspace-display";
import { useSystemEnvironmentProviders } from "@/hooks/queries/environment-provider-queries";
import { formatWorkspaceCheckoutDisplay } from "@/lib/workspace-checkout-display";
import { BbHttpError } from "@/lib/sdk";
import {
  getProjectComposeRoutePath,
  getThreadRoutePath,
} from "@/lib/route-paths";

export function PluginThreadChat({
  threadId,
  variant = "full",
  layout = "contained",
  focusRequest,
  permissionPolicy = "inherit",
  className,
  leadingContent,
}: ThreadChatProps) {
  const containerClassName = cn(
    layout === "contained" ? "flex h-full min-h-0 flex-col" : "flex flex-col",
    className,
  );
  return (
    <div className={containerClassName}>
      <PluginThreadChatBody
        threadId={threadId}
        variant={variant}
        layout={layout}
        focusRequest={focusRequest}
        permissionPolicy={permissionPolicy}
        leadingContent={leadingContent}
      />
    </div>
  );
}

interface PluginThreadChatBodyProps {
  threadId: string;
  variant: "full" | "compact" | "timeline";
  layout: "contained" | "document";
  focusRequest: number | undefined;
  permissionPolicy: "inherit" | "editable";
  leadingContent: ReactNode;
}

function PluginThreadChatBody({
  threadId,
  variant,
  layout,
  focusRequest,
  permissionPolicy,
  leadingContent,
}: PluginThreadChatBodyProps) {
  const threadQuery = useThread(threadId, { enabled: threadId.length > 0 });
  const thread = threadQuery.data;
  const navigate = useNavigate();
  const localHostId = useLocalHostId();
  const environmentQuery = useEnvironment(thread?.environmentId ?? null);
  const environment = environmentQuery.data ?? null;
  const hostsQuery = useHosts({ enabled: environment !== null });
  const environmentHost = environment
    ? (hostsQuery.data?.find((host) => host.id === environment.hostId) ?? null)
    : null;
  const hasMultipleMachines = (hostsQuery.data?.length ?? 0) > 1;
  const { providers: environmentProviders } = useSystemEnvironmentProviders();
  const timelineNavigation = useThreadTimelineNavigation();
  const canUseHostFileNavigation =
    thread !== undefined &&
    thread.environmentId === timelineNavigation?.environmentId;
  const onOpenLink = timelineNavigation?.onOpenLink;
  const onOpenLocalFileLink = canUseHostFileNavigation
    ? timelineNavigation.onOpenLocalFileLink
    : undefined;
  const resolveHostMentionLink = canUseHostFileNavigation
    ? timelineNavigation.resolveMentionLink
    : undefined;
  const workspaceRootPath =
    environment?.path ??
    (canUseHostFileNavigation
      ? timelineNavigation.workspaceRootPath
      : undefined);
  const resolveMentionLink = useCallback<PromptMentionLinkResolver>(
    (resource) => {
      if (resource.kind === "thread") {
        const targetProjectId = resource.projectId ?? thread?.projectId;
        if (targetProjectId === undefined) return null;
        return () =>
          navigate(
            getThreadRoutePath({
              projectId: targetProjectId,
              threadId: resource.threadId,
            }),
          );
      }
      if (resource.kind === "project") {
        return () => navigate(getProjectComposeRoutePath(resource.projectId));
      }
      if (
        resource.kind === "path" &&
        resource.entryKind === "file" &&
        resource.source === "workspace"
      ) {
        return resolveHostMentionLink?.(resource) ?? null;
      }
      return null;
    },
    [navigate, resolveHostMentionLink, thread?.projectId],
  );

  const environmentSummary = useMemo(() => {
    if (environment === null) {
      return null;
    }
    const host: EnvironmentDisplayHostContext = {
      locality: environment.hostId === localHostId ? "local" : "remote",
      identity: null,
    };
    const providerLookup = findEnvironmentDisplayProvider(
      environmentProviders,
      environment.environmentProviderId,
    );
    const display = formatEnvironmentDisplay({
      environment,
      host,
      providerLookup,
    });
    const chrome = getEnvironmentSummaryChrome({
      display,
      providerLookup,
      hasMultipleMachines,
      host: environmentHost,
    });
    return (
      <ThreadEnvironmentSummary
        environmentLabel={chrome.environmentLabel}
        environmentCompactLabel={chrome.environmentCompactLabel}
        environmentHost={chrome.environmentHost}
        environmentIcon={chrome.environmentIcon}
        environmentProviderName={chrome.environmentProviderName}
        environmentCheckout={
          environment.branchName
            ? formatWorkspaceCheckoutDisplay({
                checkout: {
                  kind: "branch",
                  branchName: environment.branchName,
                  headSha: null,
                },
              })
            : undefined
        }
      />
    );
  }, [
    environment,
    environmentHost,
    environmentProviders,
    hasMultipleMachines,
    localHostId,
  ]);

  const isThreadMissing =
    threadQuery.error instanceof BbHttpError &&
    threadQuery.error.status === 404;
  if (isThreadMissing) {
    return (
      <EmptyStatePanel className="m-2 rounded-lg">
        This thread is no longer available.
      </EmptyStatePanel>
    );
  }
  if (thread === undefined) {
    return (
      <div className="space-y-2 px-4 pt-4">
        <Skeleton className="h-4 w-3/4 rounded-sm" />
        <Skeleton className="h-4 w-2/3 rounded-sm" />
        <Skeleton className="h-4 w-1/2 rounded-sm" />
      </div>
    );
  }

  if (variant === "timeline") {
    const transcript = (
      <ThreadTimelinePanelContent
        leadingContent={leadingContent}
        onOpenLink={onOpenLink}
        onOpenLocalFileLink={onOpenLocalFileLink}
        projectId={thread.projectId}
        resolveMentionLink={resolveMentionLink}
        surfaceKey={`plugin-thread-chat:${threadId}`}
        threadId={threadId}
        workspaceRootPath={workspaceRootPath}
      />
    );
    return layout === "contained" ? (
      <div className="min-h-0 flex-1 overflow-y-auto bg-background px-2 pb-3 pt-3">
        {transcript}
      </div>
    ) : (
      <div className="bg-background px-2 pb-3 pt-3">{transcript}</div>
    );
  }

  return (
    <EmbeddedThreadChat
      variant="compact"
      layout={layout}
      measure={variant === "full" ? "page" : "panel"}
      surfaceTone={variant === "compact" ? "sidebar" : "background"}
      threadId={threadId}
      projectId={thread.projectId}
      providerId={thread.providerId}
      promptContextEnvironmentId={thread.environmentId}
      resolveMentionLink={resolveMentionLink}
      leadingContent={leadingContent}
      onOpenLink={onOpenLink}
      onOpenLocalFileLink={onOpenLocalFileLink}
      workspaceRootPath={workspaceRootPath}
      composer={{
        draftScope: {
          kind: "thread",
          projectId: thread.projectId,
          threadId,
        },
        executionDefaultsThreadId: threadId,
        executionResetKey: threadId,
        executionEnvironmentId: thread.environmentId ?? undefined,
        executionEnvironmentHostId: environment?.hostId,
        permissionPolicy:
          permissionPolicy === "editable" ? "editable" : "snapshot",
        environmentSummary,
        focusRequestKey: focusRequest,
      }}
    />
  );
}
