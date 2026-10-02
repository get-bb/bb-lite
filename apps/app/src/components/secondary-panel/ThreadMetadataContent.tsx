import { EnvironmentProviderIcon } from "@/components/plugin/EnvironmentProviderIcon";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
  type UIEvent,
} from "react";
import { Link } from "react-router-dom";
import type {
  Environment,
  GitBranchRefClassification,
  Thread,
  ThreadListEntry,
  WorkspaceCommitSummary,
  WorkspaceResolutionFailure,
  WorkspaceStatus,
} from "@bb/domain";
import {
  formatEnvironmentDisplay,
  type EnvironmentDisplayHostContext,
} from "@bb/core-ui";
import { cn } from "@bb/shared-ui/lib/utils";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import {
  findEnvironmentDisplayProvider,
  getEnvironmentWorkspaceInfoDisplay,
} from "@/lib/environment-workspace-display";
import { useSystemEnvironmentProviders } from "@/hooks/queries/environment-provider-queries";
import { useHosts } from "@/hooks/queries/host-queries";
import { MachineLabel } from "@/components/machines/MachineLabel";
import { formatWorkspaceCheckoutDisplay } from "@/lib/workspace-checkout-display";
import { Button } from "@bb/shared-ui/button";
import { CopyableInlineLabel } from "@/components/ui/copy-button.js";
import { TruncatedList } from "@/components/ui/truncated-list.js";
import {
  DetailCard,
  DetailRow,
  DetailRowIconLabel,
} from "@/components/ui/detail-card.js";
import { CHROME_SECTION_LABEL_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import { useCreateThreadInEnvironment } from "@/hooks/useCreateThreadInEnvironment";
import { Icon } from "@bb/shared-ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import {
  BranchPicker,
  getMergeBaseBranchCandidateGroups,
} from "@/components/pickers/BranchPicker";
import { ThreadUnarchiveButton } from "@/components/thread/ThreadUnarchiveButton";
import { ChangedFilesDetailRow } from "@/components/workspace/ChangedFilesDetailRow";
import {
  selectWorkspaceAheadCommits,
  selectWorkspaceChangedFilesSections,
  type WorkspaceChangedFileSelection,
} from "@/components/workspace/workspace-change-summary";
import { getGitStatusDisplay } from "@/components/workspace/workspace-status";
import { useUnarchiveThread } from "../../hooks/mutations/thread-state-mutations";
import { useThreads } from "@/hooks/queries/thread-queries";
import { buildParentSelectorOptions } from "@/views/thread-detail/threadParentSelectorOptions";
import { getThreadRoutePath } from "@/lib/route-paths";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { ThreadTitle } from "@/components/thread/ThreadTitleMentions";
import { ParentThreadPicker } from "@/components/pickers/ParentThreadPicker";

function ParentSelectorRow({
  thread,
  projectId,
  parentThreadProjectId,
  parentThreadDisplayName,
  parentThreads,
  canAssignToParent,
  canTakeOverThread,
  isLoadingParentThreads,
  isParentThreadsError,
  updateThreadPending,
  onAssignParent,
  onParentSelectorOpenChange,
  onRetryParentThreads,
}: ThreadMetadataContentProps) {
  const parentThreadId = thread.parentThreadId ?? undefined;
  const parentSelectorOptions = useMemo(
    () =>
      buildParentSelectorOptions({
        currentThreadId: thread.id,
        parentThreads,
        parentThreadDisplayName,
        parentThreadId,
      }),
    [parentThreads, parentThreadDisplayName, parentThreadId, thread.id],
  );
  const parentSelectorValue = parentThreadId ?? "none";
  const selectedParentOptionLabel = parentSelectorOptions.find(
    (option) => option.value === parentSelectorValue,
  )?.label;

  if (!parentThreadId && !canAssignToParent && !canTakeOverThread) {
    return null;
  }

  return (
    <DetailRow
      label={<DetailRowIconLabel icon="UserRound">Parent</DetailRowIconLabel>}
      valueClassName="min-w-0"
    >
      {parentThreadId ? (
        <div
          className={cn(
            "inline-flex max-w-full min-w-0 items-center gap-1 text-foreground",
            "text-xs",
          )}
        >
          <Link
            to={getThreadRoutePath({
              projectId: parentThreadProjectId ?? projectId,
              threadId: parentThreadId,
            })}
            className={cn(
              "block min-w-0 text-foreground no-underline transition-[text-decoration-color] duration-150 hover:underline hover:underline-offset-2",
              "text-xs",
            )}
          >
            <ThreadTitle
              title={selectedParentOptionLabel ?? "Parent thread"}
              tooltip
            />
          </Link>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-3.5 shrink-0 rounded-full p-0 text-muted-foreground hover:bg-transparent hover:text-foreground [&_[data-icon-root]]:size-3"
            disabled={updateThreadPending}
            onClick={() => {
              onAssignParent(null);
            }}
            aria-label="Clear parent thread"
          >
            <Icon name="X" />
          </Button>
        </div>
      ) : (
        <ParentThreadPicker
          value={parentSelectorValue}
          options={parentSelectorOptions}
          isLoading={isLoadingParentThreads}
          isError={isParentThreadsError}
          disabled={updateThreadPending}
          onChange={(value) => {
            onAssignParent(value === "none" ? null : value);
          }}
          onOpenChange={onParentSelectorOpenChange}
          onRetry={onRetryParentThreads}
        />
      )}
    </DetailRow>
  );
}

function ForksRow({ thread, projectId }: ThreadMetadataContentProps) {
  const forksQuery = useThreads({
    projectId: thread.projectId,
    sourceThreadId: thread.id,
    originKind: "fork",
    archived: false,
  });
  const forks = forksQuery.data ?? [];
  if (forks.length === 0) {
    return null;
  }

  return (
    <DetailRow label="Forks" align="start" valueClassName="min-w-0">
      <TruncatedList
        items={forks}
        getKey={(fork) => fork.id}
        renderItem={(fork) => (
          <Link
            to={getThreadRoutePath({ projectId, threadId: fork.id })}
            className="block min-w-0 text-xs text-foreground no-underline transition-[text-decoration-color] duration-150 hover:underline hover:underline-offset-2"
          >
            <ThreadTitle title={getThreadDisplayTitle(fork)} tooltip />
          </Link>
        )}
      />
    </DetailRow>
  );
}

function EnvironmentRow({
  thread,
  environment,
  environmentDisplayHost,
}: ThreadMetadataContentProps) {
  const createThreadInEnvironment = useCreateThreadInEnvironment({
    projectId: thread.projectId,
    environmentId: environment?.id ?? "",
    sectionId: thread.sectionId,
    pinned: thread.pinnedAt !== null,
  });
  const { providers } = useSystemEnvironmentProviders();
  const hosts = useHosts();
  if (!environment) return null;
  const environmentHost = hosts.data?.find(
    (host) => host.id === environment.hostId,
  );
  const providerLookup = findEnvironmentDisplayProvider(
    providers,
    environment.environmentProviderId,
  );
  const display = formatEnvironmentDisplay({
    environment,
    host: environmentDisplayHost,
    providerLookup,
  });
  const infoDisplay = getEnvironmentWorkspaceInfoDisplay({
    display,
    providerLookup,
    hostName: environmentDisplayHost.identity?.name ?? null,
    locality: environmentDisplayHost.locality,
  });
  const displayHost = environmentHost ?? {
    name:
      environmentDisplayHost.identity?.name ?? infoDisplay.machineName ?? "",
  };
  const showCreateThreadButton =
    environment.hostLifecycle === "active" &&
    isReusableEnvironment(environment);
  return (
    <DetailRow
      label={
        providerLookup.status === "loaded" &&
        providerLookup.provider !== null ? (
          <span className="flex items-center gap-1.5">
            <EnvironmentProviderIcon
              provider={providerLookup.provider}
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <span className="min-w-0 truncate">Environment</span>
          </span>
        ) : (
          <DetailRowIconLabel icon={infoDisplay.icon}>
            Environment
          </DetailRowIconLabel>
        )
      }
      valueClassName="min-w-0"
    >
      <span className="flex min-w-0 items-center gap-1">
        <span className="min-w-0 truncate" title={infoDisplay.label}>
          {infoDisplay.label}
        </span>
        {infoDisplay.machineName !== null && environmentDisplayHost.identity ? (
          <span
            className="inline-flex min-w-0 shrink-0 items-center gap-1.5 text-muted-foreground"
            title={`On ${environmentDisplayHost.identity.name} (${
              environment.hostLifecycle !== "active"
                ? "unavailable"
                : environmentDisplayHost.identity.connected
                  ? "connected"
                  : "offline"
            })`}
          >
            <span>·</span>
            <MachineLabel host={displayHost} />
            {environmentDisplayHost.identity.connected ||
            environment.hostLifecycle !== "active" ? null : (
              <span>(offline)</span>
            )}
          </span>
        ) : null}
        {showCreateThreadButton ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="New thread in this environment"
                onClick={createThreadInEnvironment}
                className="inline-flex shrink-0 items-center justify-center rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
              >
                <Icon name="MessageSquarePlus" className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>New thread in this environment</TooltipContent>
          </Tooltip>
        ) : null}
      </span>
    </DetailRow>
  );
}

function EnvironmentProvisioningFailureRow({
  environmentProvisioningFailure,
}: ThreadMetadataContentProps) {
  if (!environmentProvisioningFailure) return null;
  return (
    <DetailRow
      label={
        <DetailRowIconLabel icon="AlertTriangle">
          Environment
        </DetailRowIconLabel>
      }
      valueClassName="min-w-0"
    >
      <span className="flex min-w-0 items-center gap-1">
        <span className="min-w-0 truncate">Not created</span>
        <span className="shrink-0 text-muted-foreground">
          · provisioning failed
        </span>
      </span>
    </DetailRow>
  );
}

function isReusableEnvironment(environment: Environment): boolean {
  return environment.status === "ready" && environment.path !== null;
}

function WorkspacePathRow({ environment }: ThreadMetadataContentProps) {
  if (!environment?.path) return null;

  return (
    <DetailRow
      label={<DetailRowIconLabel icon="Folder">Directory</DetailRowIconLabel>}
      valueClassName="min-w-0"
    >
      <CopyableInlineLabel
        text={environment.path}
        label="Copy directory"
        title={environment.path}
        successMessage="Directory copied"
        errorMessage="Failed to copy directory"
      />
    </DetailRow>
  );
}

function BranchRow({ workspaceStatus }: ThreadMetadataContentProps) {
  const checkoutDisplay = workspaceStatus
    ? formatWorkspaceCheckoutDisplay({ checkout: workspaceStatus.checkout })
    : null;
  if (checkoutDisplay === null) return null;
  return (
    <DetailRow
      label={
        <DetailRowIconLabel icon="GitBranch">
          {checkoutDisplay.rowLabel}
        </DetailRowIconLabel>
      }
      valueClassName="min-w-0 truncate"
    >
      {checkoutDisplay.copyValue !== null ? (
        <CopyableInlineLabel
          text={checkoutDisplay.copyValue}
          label={checkoutDisplay.copyLabel ?? "Copy checkout value"}
          title={checkoutDisplay.title}
          successMessage={checkoutDisplay.copySuccessMessage ?? "Value copied"}
          errorMessage={
            checkoutDisplay.copyErrorMessage ?? "Failed to copy value"
          }
        >
          {checkoutDisplay.label}
        </CopyableInlineLabel>
      ) : (
        <span className="block truncate" title={checkoutDisplay.title}>
          {checkoutDisplay.label}
        </span>
      )}
    </DetailRow>
  );
}

function resolveDisplayedMergeBaseBranch(
  selectedMergeBaseBranch: string | undefined,
  workspaceStatus: WorkspaceStatus | undefined,
): string | undefined {
  return (
    selectedMergeBaseBranch ??
    workspaceStatus?.mergeBase?.mergeBaseBranch ??
    workspaceStatus?.branch.defaultBranch
  );
}

function shouldShowWorkspaceStatus({
  thread,
  environment,
  workspaceStatus,
  workspaceStatusError,
  workspaceUnavailable,
}: ThreadMetadataContentProps): boolean {
  return (
    (Boolean(workspaceStatus) ||
      Boolean(workspaceStatusError) ||
      Boolean(workspaceUnavailable) ||
      environment?.status === "destroyed") &&
    !(thread.archivedAt != null && environment?.managed !== true)
  );
}

function MergeBaseRow({
  workspaceStatus,
  selectedMergeBaseBranch,
  mergeBaseBranchRef,
  mergeBaseBranchOptions,
  mergeBaseRemoteBranchOptions,
  isLoadingMergeBaseBranchOptions,
  onMergeBaseBranchChange,
  onMergeBasePickerOpenChange,
  onMergeBaseBranchSearchQueryChange,
}: ThreadMetadataContentProps) {
  const mergeBaseBranch = resolveDisplayedMergeBaseBranch(
    selectedMergeBaseBranch,
    workspaceStatus,
  );
  const mergeBaseCandidateGroups = useMemo(
    () =>
      getMergeBaseBranchCandidateGroups({
        mergeBaseBranch,
        mergeBaseBranchRef,
        mergeBaseBranchOptions,
        remoteMergeBaseBranchOptions: mergeBaseRemoteBranchOptions,
      }),
    [
      mergeBaseBranch,
      mergeBaseBranchOptions,
      mergeBaseBranchRef,
      mergeBaseRemoteBranchOptions,
    ],
  );
  const mergeBaseCandidates = mergeBaseCandidateGroups.options;
  const remoteMergeBaseCandidates = mergeBaseCandidateGroups.remoteOptions;
  const isOnDefaultBranch =
    workspaceStatus?.branch.currentBranch != null &&
    workspaceStatus.branch.currentBranch ===
      workspaceStatus.branch.defaultBranch;
  const showMergeBase = Boolean(mergeBaseBranch) && !isOnDefaultBranch;
  if (!showMergeBase) return null;
  const canRequestMergeBaseOptions =
    mergeBaseBranchOptions === undefined &&
    onMergeBasePickerOpenChange !== undefined;
  const canSelectMergeBase = Boolean(
    mergeBaseBranch &&
    (canRequestMergeBaseOptions ||
      isLoadingMergeBaseBranchOptions ||
      mergeBaseCandidates.length > 0 ||
      remoteMergeBaseCandidates.length > 0),
  );

  return (
    <DetailRow
      label={
        <DetailRowIconLabel icon="GitMerge">Merge base</DetailRowIconLabel>
      }
      valueClassName="min-w-0"
    >
      {canSelectMergeBase && mergeBaseBranch ? (
        <BranchPicker
          value={mergeBaseBranch}
          options={mergeBaseCandidates}
          remoteOptions={remoteMergeBaseCandidates}
          loading={
            isLoadingMergeBaseBranchOptions || canRequestMergeBaseOptions
          }
          onChange={onMergeBaseBranchChange}
          onOpenChange={onMergeBasePickerOpenChange}
          onSearchQueryChange={onMergeBaseBranchSearchQueryChange}
          className="max-w-full"
        />
      ) : (
        mergeBaseBranch
      )}
    </DetailRow>
  );
}

function GitStatusRow(props: ThreadMetadataContentProps) {
  const {
    environment,
    workspaceStatus,
    workspaceStatusError,
    workspaceUnavailable,
    selectedMergeBaseBranch,
  } = props;
  if (!shouldShowWorkspaceStatus(props)) return null;

  const isWorkspaceDeleted = environment?.status === "destroyed";
  const effectiveMergeBaseBranch = resolveDisplayedMergeBaseBranch(
    selectedMergeBaseBranch,
    workspaceStatus,
  );
  const showBranchComparisonUi = Boolean(
    effectiveMergeBaseBranch || workspaceStatus?.branch.defaultBranch,
  );
  const display = getGitStatusDisplay(workspaceStatus, {
    mergeBaseBranch: effectiveMergeBaseBranch,
    showBranchComparison: showBranchComparisonUi,
    error: workspaceStatusError,
    workspaceUnavailable,
    workspaceDeleted: isWorkspaceDeleted,
  });
  const labelClass =
    display.label === "Dirty" ? "text-destructive" : "text-foreground";

  return (
    <DetailRow
      label={
        <DetailRowIconLabel icon="FileDiff">Git status</DetailRowIconLabel>
      }
      align="start"
      valueClassName="min-w-0"
    >
      <div
        className="flex min-w-0 items-end gap-2 whitespace-nowrap"
        title={`${display.label} ${display.summary}`}
      >
        <span className={cn("shrink-0 font-medium", labelClass)}>
          {display.label}
        </span>
        <span className="min-w-0 truncate text-muted-foreground">
          {display.summary}
        </span>
      </div>
    </DetailRow>
  );
}

function ArchivedRow({ thread }: ThreadMetadataContentProps) {
  const unarchiveThread = useUnarchiveThread();
  const isPending =
    unarchiveThread.isPending && unarchiveThread.variables?.id === thread.id;
  if (thread.archivedAt == null) return null;
  return (
    <DetailRow label="Archived" valueClassName="min-w-0 truncate">
      <ThreadUnarchiveButton
        isPending={isPending}
        onUnarchive={() => unarchiveThread.mutate({ id: thread.id })}
      />
    </DetailRow>
  );
}

const COMMIT_SHA_CHIP_CLASS_NAME =
  "inline-flex max-w-[45%] shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-subtle-foreground transition-colors hover:bg-state-hover hover:text-foreground";

function ThreadCommitListItem({
  commit,
  onCommitClick,
}: {
  commit: WorkspaceCommitSummary;
  onCommitClick?: (sha: string) => void;
}) {
  const subject = onCommitClick ? (
    <button
      type="button"
      onClick={() => onCommitClick(commit.sha)}
      title={commit.subject}
      className="group min-w-0 flex-1 text-left"
    >
      <span className="block min-w-0 truncate text-readback-foreground underline-offset-2 group-hover:underline">
        {commit.subject}
      </span>
    </button>
  ) : (
    <span className="min-w-0 flex-1 truncate text-readback-foreground">
      {commit.subject}
    </span>
  );

  return (
    <div className="flex min-w-0 items-center justify-between gap-2">
      {subject}
      <button
        type="button"
        aria-label={`Copy commit ${commit.shortSha} SHA`}
        className={COMMIT_SHA_CHIP_CLASS_NAME}
        onClick={() => {
          void copyToClipboardWithToast(commit.sha, {
            successMessage: "Commit SHA copied",
            errorMessage: "Failed to copy commit SHA",
          });
        }}
      >
        <span className="truncate">{commit.shortSha}</span>
      </button>
    </div>
  );
}

function ThreadCommitsRow({
  workspaceStatus,
  onCommitClick,
}: ThreadMetadataContentProps) {
  const commits = selectWorkspaceAheadCommits(workspaceStatus);
  if (commits.length === 0) return null;
  return (
    <>
      <div className="mb-1 mt-3 border-t border-border" aria-hidden />
      <DetailRow
        label="Commits"
        orientation="vertical"
        labelClassName={CHROME_SECTION_LABEL_CLASS}
        valueClassName="min-w-0"
      >
        <TruncatedList
          items={commits}
          getKey={(commit) => commit.sha}
          renderItem={(commit) => (
            <ThreadCommitListItem
              commit={commit}
              onCommitClick={onCommitClick}
            />
          )}
        />
      </DetailRow>
    </>
  );
}

function ChangedFilesRow({
  workspaceStatus,
  onChangedFileClick,
}: ThreadMetadataContentProps) {
  return (
    <ChangedFilesDetailRow
      sections={selectWorkspaceChangedFilesSections(workspaceStatus)}
      onFileClick={onChangedFileClick}
      labelClassName={CHROME_SECTION_LABEL_CLASS}
      rowClassName="mt-3"
      limit={5}
    />
  );
}

export interface ThreadMetadataContentProps {
  thread: Thread;
  projectId: string;
  parentThreadProjectId: string | null;
  parentThreadDisplayName: string | null;
  parentThreads: readonly ThreadListEntry[];
  canAssignToParent: boolean;
  canTakeOverThread: boolean;
  isLoadingParentThreads: boolean;
  isParentThreadsError: boolean;
  environment: Environment | null;
  environmentProvisioningFailure: boolean;
  environmentDisplayHost: EnvironmentDisplayHostContext;
  workspaceStatus: WorkspaceStatus | undefined;
  workspaceStatusError: Error | null;
  workspaceUnavailable?: WorkspaceResolutionFailure;
  selectedMergeBaseBranch: string | undefined;
  mergeBaseBranchRef?: GitBranchRefClassification | null;
  mergeBaseBranchOptions: readonly string[] | undefined;
  mergeBaseRemoteBranchOptions?: readonly string[];
  isLoadingMergeBaseBranchOptions: boolean;
  updateThreadPending: boolean;
  onAssignParent: (parentThreadId: string | null) => void;
  onParentSelectorOpenChange: (open: boolean) => void;
  onRetryParentThreads: () => void;
  onMergeBaseBranchChange: (branch: string) => void;
  onMergeBasePickerOpenChange?: (open: boolean) => void;
  onMergeBaseBranchSearchQueryChange?: (query: string) => void;
  onChangedFileClick?: (selection: WorkspaceChangedFileSelection) => void;
  onCommitClick?: (sha: string) => void;
}

export function hasAnyThreadMetadata(
  props: ThreadMetadataContentProps,
  hasForks: boolean,
): boolean {
  const { thread, environment, workspaceStatus } = props;
  return Boolean(
    thread.parentThreadId ||
    environment ||
    props.environmentProvisioningFailure ||
    workspaceStatus?.branch.currentBranch ||
    shouldShowWorkspaceStatus(props) ||
    selectWorkspaceChangedFilesSections(workspaceStatus).length > 0 ||
    thread.archivedAt != null ||
    hasForks,
  );
}

const INFO_SCROLLBAR_IDLE_DELAY_MS = 600;

export function ThreadMetadataCard({ children }: { children: ReactNode }) {
  const scrollbarIdleTimeoutRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (scrollbarIdleTimeoutRef.current !== null) {
        window.clearTimeout(scrollbarIdleTimeoutRef.current);
      }
    },
    [],
  );

  const handleScroll = useCallback((event: UIEvent<HTMLDListElement>) => {
    const scrollArea = event.currentTarget;
    if (scrollArea.dataset.scrollbarScrolling !== "true") {
      scrollArea.dataset.scrollbarScrolling = "true";
    }
    if (scrollbarIdleTimeoutRef.current !== null) {
      window.clearTimeout(scrollbarIdleTimeoutRef.current);
    }
    scrollbarIdleTimeoutRef.current = window.setTimeout(() => {
      scrollbarIdleTimeoutRef.current = null;
      scrollArea.removeAttribute("data-scrollbar-scrolling");
    }, INFO_SCROLLBAR_IDLE_DELAY_MS);
  }, []);

  return (
    <DetailCard
      className="transient-scrollbar min-h-0 flex-1 gap-1.5 overflow-x-hidden overflow-y-auto px-4 py-3"
      onScroll={handleScroll}
    >
      {children}
    </DetailCard>
  );
}

export function ThreadMetadataContent(props: ThreadMetadataContentProps) {
  const { environment } = props;
  const isHostActive =
    environment === null || environment.hostLifecycle === "active";
  return (
    <ThreadMetadataCard>
      <ParentSelectorRow {...props} />
      <ForksRow {...props} />
      <EnvironmentRow {...props} />
      <EnvironmentProvisioningFailureRow {...props} />
      <WorkspacePathRow {...props} />
      {isHostActive ? (
        <>
          <BranchRow {...props} />
          <MergeBaseRow {...props} />
          <GitStatusRow {...props} />
        </>
      ) : null}
      <ArchivedRow {...props} />
      {isHostActive ? (
        <>
          <ThreadCommitsRow {...props} />
          <ChangedFilesRow {...props} />
        </>
      ) : null}
    </ThreadMetadataCard>
  );
}
