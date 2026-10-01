import {
  CONTEXT_CARD_TOGGLE_CLASS,
  CONTEXT_CARD_CHEVRON_CLASS,
} from "@bb/shared-ui/chrome-style-tokens";
import {
  machineRemovalDescriptions,
  machineRemovalLabels,
  type MachineRemovalStatus,
} from "@/lib/machine-removal-display";
import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import type {
  EnvironmentStatus,
  GitBranchRefClassification,
  ThreadRuntimeDisplayStatus,
} from "@bb/domain";
import {
  BranchPicker,
  getMergeBaseBranchCandidateGroups,
} from "@/components/pickers/BranchPicker";
import {
  PromptStackCard,
  PromptStackCardChevron,
  PROMPT_STACK_CARD_HEADER_BUTTON_CLASS,
  PROMPT_STACK_CARD_ROW_HEIGHT,
  PROMPT_STACK_INLAY_INSET_CLASS,
  PROMPT_STACK_INLAY_SEGMENT_CLASS,
} from "@/components/promptbox/banner/PromptStackCard";
import {
  activityIconClass,
  activityRowClass,
} from "@bb/shared-ui/activity-row-styles";
import { WorkspaceChangesList } from "@/components/thread/WorkspaceChangesList";
import {
  formatChangeSummary,
  renderChangeSummary,
  toChangeTally,
  type WorkspaceChangedFileSelection,
  type WorkspaceChangedFilesSection,
} from "@/components/workspace/workspace-change-summary";
import { cn } from "@bb/shared-ui/lib/utils";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { AnimatedBody } from "@/components/promptbox/banner/AnimatedBody";
import {
  BannerActionSlot,
  PromptBannerActionButton,
} from "@/components/promptbox/banner/prompt-banner-actions";
import {
  ThreadTitle,
  useThreadTitleDisplayText,
} from "@/components/thread/ThreadTitleMentions";

export interface ContextBannerMergeBaseConfig {
  branch: string;
  branchRef?: GitBranchRefClassification | null;
  options?: readonly string[];
  remoteOptions?: readonly string[];
  optionsLoading?: boolean;
  onChange: (branch: string) => void;
  onPickerOpenChange?: (open: boolean) => void;
  onSearchQueryChange?: (query: string) => void;
}

export interface ThreadPromptGitSection {
  changedFiles: WorkspaceChangedFilesSection;
  mergeBase: ContextBannerMergeBaseConfig | null;
  onPromptBannerFileClick: (selection: WorkspaceChangedFileSelection) => void;
}

export interface ThreadPromptParentThreadSection {
  parentThreadTitle: string;
  href: string;
  relationship: "parent" | "fork";
}

interface ThreadPromptChildThreadItem {
  id: string;
  title: string;
  href: string;
  hasPendingInteraction: boolean;
}

export interface ThreadPromptChildThreadsSection {
  items: readonly ThreadPromptChildThreadItem[];
}

export interface ThreadPromptArchivedSection {
  archivedAt: number;
  onUnarchive?: () => void;
  unarchivePending?: boolean;
}

export interface ThreadPromptEnvironmentGoneSection {
  status: Extract<EnvironmentStatus, "destroyed"> | MachineRemovalStatus;
  onRestore?: () => void;
  restorePending?: boolean;
}

const THREAD_BANNER_ACTIVE_CHILD_RUNTIME_STATUSES: ReadonlySet<ThreadRuntimeDisplayStatus> =
  new Set(["active", "provisioning", "starting", "waiting-for-host"]);

export function isThreadDisplayStatusBannerActive(
  status: ThreadRuntimeDisplayStatus,
): boolean {
  return THREAD_BANNER_ACTIVE_CHILD_RUNTIME_STATUSES.has(status);
}

export type ThreadPromptContextBannerExpandedSection =
  | "git"
  | "parentThread"
  | "childThreads"
  | "status";

interface ThreadPromptContextBannerProps {
  gitSection: ThreadPromptGitSection | null;
  gitSectionPending: boolean;
  archivedSection: ThreadPromptArchivedSection | null;
  environmentGoneSection: ThreadPromptEnvironmentGoneSection | null;
  parentThreadSection: ThreadPromptParentThreadSection | null;
  childThreadsSection: ThreadPromptChildThreadsSection | null;
  expandedSection: ThreadPromptContextBannerExpandedSection | null;
  onToggleSection: (section: ThreadPromptContextBannerExpandedSection) => void;
}

const KIND_PREFIX: Record<WorkspaceChangedFilesSection["kind"], string> = {
  uncommitted: "Uncommitted",
  untracked: "Untracked",
  committed: "Committed",
};

const ARCHIVED_THREAD_STATUS_LABEL = "Thread is archived";
const ENVIRONMENT_GONE_STATUS_COPY: Record<
  ThreadPromptEnvironmentGoneSection["status"],
  { description: string; label: string }
> = {
  destroyed: {
    description:
      "Environment unavailable. You can still view this thread’s history.",
    label: "Environment unavailable",
  },
  removed: {
    label: machineRemovalLabels.removed,
    description: machineRemovalDescriptions.removed,
  },
  removing: {
    label: machineRemovalLabels.removing,
    description: machineRemovalDescriptions.removing,
  },
  "cleanup-failed": {
    label: machineRemovalLabels["cleanup-failed"],
    description: machineRemovalDescriptions["cleanup-failed"],
  },
};

const SECTION_IDS = {
  parentThread: {
    toggle: "thread-prompt-banner-parent-thread-toggle",
    body: "thread-prompt-banner-parent-thread-body",
  },
  childThreads: {
    toggle: "thread-prompt-banner-child-threads-toggle",
    body: "thread-prompt-banner-child-threads-body",
  },
  git: {
    toggle: "thread-prompt-banner-git-toggle",
    body: "thread-prompt-banner-git-body",
  },
  status: {
    toggle: "thread-prompt-banner-status-toggle",
    body: "thread-prompt-banner-status-body",
  },
} as const;

const SEGMENT_SHRINK_CLASS = "min-w-0 overflow-hidden";

function ChildThreadIcon({ className }: { className?: string }) {
  return (
    <Icon
      name="ChevronDown"
      className={cn("size-3.5 shrink-0 rotate-45", className)}
      aria-hidden="true"
    />
  );
}

interface SectionToggleButtonProps {
  id: string;
  controlsId: string;
  ariaLabel?: string;
  icon: ReactNode;
  label: ReactNode;
  isExpanded: boolean;
  onToggle: () => void;
}

function SectionToggleButton({
  id,
  controlsId,
  ariaLabel,
  icon,
  label,
  isExpanded,
  onToggle,
}: SectionToggleButtonProps) {
  return (
    <button
      type="button"
      id={id}
      aria-expanded={isExpanded}
      aria-controls={controlsId}
      aria-label={ariaLabel}
      onClick={onToggle}
      className={cn(
        CONTEXT_CARD_TOGGLE_CLASS,
        PROMPT_STACK_INLAY_SEGMENT_CLASS,
        SEGMENT_SHRINK_CLASS,
        label !== null && label !== undefined ? "gap-1.5" : "gap-0",
        isExpanded ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {icon}
      {label !== null && label !== undefined ? (
        <span className="min-w-0 truncate">{label}</span>
      ) : null}
      <Icon
        name="ChevronDown"
        className={cn(CONTEXT_CARD_CHEVRON_CLASS, isExpanded && "rotate-180")}
        aria-hidden="true"
      />
    </button>
  );
}

const PARENT_SECTION_COPY: Record<
  ThreadPromptParentThreadSection["relationship"],
  { verb: string; bodyLead: string; ariaPrefix: string }
> = {
  parent: {
    verb: "Parent",
    bodyLead: "This thread is a child of ",
    ariaPrefix: "Parent thread",
  },
  fork: {
    verb: "Forked from",
    bodyLead: "This thread was forked from ",
    ariaPrefix: "Forked from",
  },
};

const PARENT_SECTION_ICON: Record<
  ThreadPromptParentThreadSection["relationship"],
  IconName
> = {
  parent: "UserRound",
  fork: "Fork",
};

function useParentSectionAriaLabel(
  section: ThreadPromptParentThreadSection,
): string {
  const parentThreadTitle = useThreadTitleDisplayText(
    section.parentThreadTitle,
  );
  return `${PARENT_SECTION_COPY[section.relationship].ariaPrefix} ${parentThreadTitle}`;
}

const PARENT_THREAD_TITLE_CLASS =
  "text-foreground/90 underline underline-offset-2";

function ParentThreadInlineSegment({
  section,
}: {
  section: ThreadPromptParentThreadSection;
}) {
  const ariaLabel = useParentSectionAriaLabel(section);
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-xs",
        PROMPT_STACK_INLAY_SEGMENT_CLASS,
      )}
      title={ariaLabel}
    >
      <Icon
        name={PARENT_SECTION_ICON[section.relationship]}
        className="size-3.5 shrink-0"
        aria-hidden="true"
      />
      <span className="min-w-0 truncate">
        {PARENT_SECTION_COPY[section.relationship].verb}{" "}
        <NavLink to={section.href}>
          <ThreadTitle
            title={section.parentThreadTitle}
            className={PARENT_THREAD_TITLE_CLASS}
            inline
          />
        </NavLink>
      </span>
    </div>
  );
}

function ParentThreadSectionToggle({
  section,
  isExpanded,
  onToggle,
}: {
  section: ThreadPromptParentThreadSection;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const ariaLabel = useParentSectionAriaLabel(section);
  return (
    <SectionToggleButton
      id={SECTION_IDS.parentThread.toggle}
      controlsId={SECTION_IDS.parentThread.body}
      ariaLabel={ariaLabel}
      icon={
        <Icon
          name={PARENT_SECTION_ICON[section.relationship]}
          className="size-3.5 shrink-0"
          aria-hidden="true"
        />
      }
      label={null}
      isExpanded={isExpanded}
      onToggle={onToggle}
    />
  );
}

function ParentThreadSectionBody({
  section,
  isExpanded,
}: {
  section: ThreadPromptParentThreadSection;
  isExpanded: boolean;
}) {
  return (
    <AnimatedBody
      collapsedBorder="reserve"
      id={SECTION_IDS.parentThread.body}
      labelledBy={SECTION_IDS.parentThread.toggle}
      isExpanded={isExpanded}
    >
      <div className="px-3 pb-2 pt-1.5 text-xs leading-relaxed text-muted-foreground">
        {PARENT_SECTION_COPY[section.relationship].bodyLead}
        <NavLink to={section.href}>
          <ThreadTitle
            title={section.parentThreadTitle}
            className={PARENT_THREAD_TITLE_CLASS}
            inline
          />
        </NavLink>
        .
      </div>
    </AnimatedBody>
  );
}

function ChildThreadsBody({
  items,
}: {
  items: readonly ThreadPromptChildThreadItem[];
}) {
  return (
    <ul className="max-h-40 space-y-0.5 overflow-y-auto px-3 pb-2 pt-1.5">
      {items.map((item) => (
        <li key={item.id} className="text-xs">
          <NavLink
            to={item.href}
            className="flex min-w-0 items-center gap-2 py-0.5 text-foreground/90 underline-offset-2 hover:underline"
          >
            {item.hasPendingInteraction ? (
              <Icon
                name="CircleQuestion"
                className="size-3.5 shrink-0 text-muted-foreground/75 no-underline"
                aria-hidden="true"
              />
            ) : (
              <ChildThreadIcon className="text-subtle-foreground no-underline" />
            )}
            <ThreadTitle title={item.title} tooltip className="flex-1" />
            {item.hasPendingInteraction ? (
              <span className="shrink-0 text-muted-foreground">
                Needs input
              </span>
            ) : null}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

function PendingBannerActionButton({
  pending,
  label,
  pendingLabel,
  onClick,
}: {
  pending: boolean;
  label: string;
  pendingLabel: string;
  onClick: () => void;
}) {
  return (
    <PromptBannerActionButton onClick={onClick} disabled={pending}>
      {pending ? pendingLabel : label}
    </PromptBannerActionButton>
  );
}

function childThreadsLabel(args: {
  count: number;
  pendingCount: number;
}): string {
  if (args.pendingCount > 0) {
    return `${args.pendingCount} child ${args.pendingCount === 1 ? "thread needs" : "threads need"} input`;
  }
  return `${args.count} active child ${args.count === 1 ? "thread" : "threads"}`;
}

function ActiveChildThreadsCard({
  childThreadsSection,
  isExpanded,
  onToggle,
}: {
  childThreadsSection: ThreadPromptChildThreadsSection;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const items = [...childThreadsSection.items].sort((left, right) =>
    left.hasPendingInteraction === right.hasPendingInteraction
      ? 0
      : left.hasPendingInteraction
        ? -1
        : 1,
  );
  const primary = items[0];
  const primaryTitle = useThreadTitleDisplayText(primary?.title ?? "");
  if (!primary) {
    return null;
  }
  const pendingCount = items.filter(
    (item) => item.hasPendingInteraction,
  ).length;
  const otherCount = items.length - 1;
  const groupLabel = childThreadsLabel({
    count: items.length,
    pendingCount,
  });
  const needsApproval = pendingCount > 0;
  return (
    <PromptStackCard
      ariaLabel="Child threads"
      className="overflow-hidden"
      style={{ minHeight: PROMPT_STACK_CARD_ROW_HEIGHT }}
    >
      <div className="flex items-center">
        <button
          type="button"
          id={SECTION_IDS.childThreads.toggle}
          aria-expanded={isExpanded}
          aria-controls={SECTION_IDS.childThreads.body}
          aria-label={`${groupLabel}: ${primaryTitle}`}
          onClick={onToggle}
          className={
            needsApproval
              ? PROMPT_STACK_CARD_HEADER_BUTTON_CLASS
              : activityRowClass(
                  "active",
                  PROMPT_STACK_CARD_HEADER_BUTTON_CLASS,
                )
          }
        >
          <Icon
            name={needsApproval ? "CircleQuestion" : "UserRound"}
            className={
              needsApproval
                ? "size-3.5 shrink-0 text-muted-foreground/75"
                : activityIconClass("active", "size-3.5 shrink-0")
            }
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate text-left">
            <span className="text-muted-foreground">
              {needsApproval ? "Needs your input: " : "Active child thread: "}
            </span>
            <ThreadTitle
              title={primary.title}
              className="font-medium text-foreground/80"
              inline
            />
          </span>
          {otherCount > 0 ? (
            <span className="shrink-0 text-muted-foreground">
              +{otherCount} more
            </span>
          ) : null}
          <PromptStackCardChevron
            isExpanded={isExpanded}
            className="text-muted-foreground"
          />
        </button>
      </div>
      <AnimatedBody
        collapsedBorder="reserve"
        id={SECTION_IDS.childThreads.body}
        labelledBy={SECTION_IDS.childThreads.toggle}
        isExpanded={isExpanded}
      >
        <ChildThreadsBody items={items} />
      </AnimatedBody>
    </PromptStackCard>
  );
}

interface ReadOnlyContextBannerProps {
  iconName: IconName;
  statusLabel: string;
  description: string | null;
  parentThreadSection: ThreadPromptParentThreadSection | null;
  statusAction: ReactNode;
  expandedSection: ThreadPromptContextBannerExpandedSection | null;
  onToggleSection: (section: ThreadPromptContextBannerExpandedSection) => void;
}

function ReadOnlyContextBanner({
  iconName,
  statusLabel,
  description,
  parentThreadSection,
  statusAction,
  expandedSection,
  onToggleSection,
}: ReadOnlyContextBannerProps) {
  const isParentThreadExpanded =
    expandedSection === "parentThread" && parentThreadSection !== null;
  const isStatusExpanded = expandedSection === "status" && description !== null;
  const hasMultipleSegments = parentThreadSection !== null;
  const statusIcon = (
    <Icon name={iconName} className="size-3.5 shrink-0" aria-hidden="true" />
  );
  const showStatusAction = statusAction !== null && !hasMultipleSegments;
  return (
    <PromptStackCard
      ariaLabel="Thread history"
      className="overflow-hidden"
      style={{ minHeight: PROMPT_STACK_CARD_ROW_HEIGHT }}
    >
      <div
        className={cn(
          "flex items-center gap-0.5 text-xs text-muted-foreground",
          PROMPT_STACK_INLAY_INSET_CLASS,
        )}
      >
        {parentThreadSection ? (
          <ParentThreadSectionToggle
            section={parentThreadSection}
            isExpanded={isParentThreadExpanded}
            onToggle={() => onToggleSection("parentThread")}
          />
        ) : null}
        {description === null ? (
          <div
            className={cn(
              "flex min-w-0 items-center gap-1.5 text-xs",
              PROMPT_STACK_INLAY_SEGMENT_CLASS,
            )}
            role="status"
            aria-label={statusLabel}
          >
            {statusIcon}
            <span className="min-w-0 truncate" aria-hidden="true">
              {statusLabel}
            </span>
          </div>
        ) : (
          <SectionToggleButton
            id={SECTION_IDS.status.toggle}
            controlsId={SECTION_IDS.status.body}
            icon={statusIcon}
            label={statusLabel}
            isExpanded={isStatusExpanded}
            onToggle={() => onToggleSection("status")}
          />
        )}
        {showStatusAction ? (
          <BannerActionSlot>{statusAction}</BannerActionSlot>
        ) : null}
      </div>
      {description === null ? null : (
        <AnimatedBody
          collapsedBorder="reserve"
          id={SECTION_IDS.status.body}
          labelledBy={SECTION_IDS.status.toggle}
          isExpanded={isStatusExpanded}
        >
          <p className="px-3 pb-2 pt-1.5 text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        </AnimatedBody>
      )}
      {parentThreadSection ? (
        <ParentThreadSectionBody
          section={parentThreadSection}
          isExpanded={isParentThreadExpanded}
        />
      ) : null}
    </PromptStackCard>
  );
}

export function ThreadPromptContextBanner({
  gitSection,
  gitSectionPending,
  archivedSection,
  environmentGoneSection,
  parentThreadSection,
  childThreadsSection,
  expandedSection,
  onToggleSection,
}: ThreadPromptContextBannerProps) {
  if (archivedSection || environmentGoneSection) {
    const environmentGone = environmentGoneSection !== null;
    const environmentGoneCopy = environmentGoneSection
      ? ENVIRONMENT_GONE_STATUS_COPY[environmentGoneSection.status]
      : null;
    return (
      <ReadOnlyContextBanner
        iconName={environmentGone ? "CircleX" : "Archive"}
        statusLabel={environmentGoneCopy?.label ?? ARCHIVED_THREAD_STATUS_LABEL}
        description={environmentGoneCopy?.description ?? null}
        statusAction={
          archivedSection?.onUnarchive ? (
            <PendingBannerActionButton
              pending={Boolean(archivedSection.unarchivePending)}
              label="Unarchive"
              pendingLabel="Unarchiving..."
              onClick={archivedSection.onUnarchive}
            />
          ) : environmentGoneSection?.onRestore ? (
            <PendingBannerActionButton
              pending={Boolean(environmentGoneSection.restorePending)}
              label="Restore workspace"
              pendingLabel="Restoring..."
              onClick={environmentGoneSection.onRestore}
            />
          ) : null
        }
        parentThreadSection={parentThreadSection}
        expandedSection={expandedSection}
        onToggleSection={onToggleSection}
      />
    );
  }
  if (gitSectionPending) {
    return null;
  }
  const showGit = gitSection !== null;
  const showParentThread = parentThreadSection !== null;
  const showChildThreads =
    childThreadsSection !== null && childThreadsSection.items.length > 0;
  if (!showGit && !showParentThread && !showChildThreads) {
    return null;
  }
  const visibleSegmentCount = Number(showParentThread) + Number(showGit);
  const hasSingleVisibleSegment = visibleSegmentCount === 1;
  const isGitExpanded = expandedSection === "git" && showGit;
  const isParentThreadExpanded =
    expandedSection === "parentThread" && showParentThread;
  const isChildThreadsExpanded =
    expandedSection === "childThreads" && showChildThreads;
  const activeChildThreadsCard =
    showChildThreads && childThreadsSection ? (
      <ActiveChildThreadsCard
        childThreadsSection={childThreadsSection}
        isExpanded={isChildThreadsExpanded}
        onToggle={() => onToggleSection("childThreads")}
      />
    ) : null;
  const gitTally = showGit
    ? toChangeTally(gitSection.changedFiles.stats)
    : null;
  const gitSummaryText = gitTally ? formatChangeSummary(gitTally) : "";
  const gitSummaryPrefix = showGit
    ? KIND_PREFIX[gitSection.changedFiles.kind]
    : "";
  const gitSummary: ReactNode =
    showGit && gitTally ? (
      <>
        {gitSummaryPrefix} · {renderChangeSummary(gitTally)}
      </>
    ) : null;

  const mergeBaseCandidates =
    showGit && gitSection.mergeBase
      ? getMergeBaseBranchCandidateGroups({
          mergeBaseBranch: gitSection.mergeBase.branch,
          mergeBaseBranchRef: gitSection.mergeBase.branchRef,
          mergeBaseBranchOptions: gitSection.mergeBase.options,
          remoteMergeBaseBranchOptions: gitSection.mergeBase.remoteOptions,
        })
      : { options: [], remoteOptions: [] };
  const segmentAction =
    hasSingleVisibleSegment && showGit && gitSection.mergeBase ? (
      <BannerActionSlot hideInCompact>
        <Icon
          name="GitMerge"
          className="size-3.5 shrink-0"
          aria-hidden="true"
        />
        <span className="shrink-0">Merge base</span>
        <BranchPicker
          value={gitSection.mergeBase.branch}
          options={mergeBaseCandidates.options}
          remoteOptions={mergeBaseCandidates.remoteOptions}
          variant="minimal"
          emphasizeTriggerValue={false}
          loading={gitSection.mergeBase.optionsLoading}
          onChange={gitSection.mergeBase.onChange}
          onOpenChange={gitSection.mergeBase.onPickerOpenChange}
          onSearchQueryChange={gitSection.mergeBase.onSearchQueryChange}
          className="max-w-[10rem]"
          muted
          popoverAlign="end"
        />
      </BannerActionSlot>
    ) : null;

  const isParentThreadOnly = showParentThread && !showGit;

  const compactContextBanner =
    visibleSegmentCount > 0 ? (
      <PromptStackCard
        ariaLabel="Thread context before sending"
        className="overflow-hidden"
        style={{ minHeight: PROMPT_STACK_CARD_ROW_HEIGHT }}
      >
        <div
          className={cn(
            "flex items-center gap-0.5 text-xs text-muted-foreground",
            PROMPT_STACK_INLAY_INSET_CLASS,
          )}
        >
          {showParentThread && parentThreadSection && isParentThreadOnly ? (
            <ParentThreadInlineSegment section={parentThreadSection} />
          ) : null}
          {showParentThread && parentThreadSection && !isParentThreadOnly ? (
            <ParentThreadSectionToggle
              section={parentThreadSection}
              isExpanded={isParentThreadExpanded}
              onToggle={() => onToggleSection("parentThread")}
            />
          ) : null}
          {showGit && gitSummary ? (
            <SectionToggleButton
              id={SECTION_IDS.git.toggle}
              controlsId={SECTION_IDS.git.body}
              icon={
                <Icon
                  name="FileDiff"
                  className="size-3.5 shrink-0"
                  aria-hidden="true"
                />
              }
              label={gitSummary}
              ariaLabel={`Changed files: ${gitSummaryPrefix}, ${gitSummaryText}`}
              isExpanded={isGitExpanded}
              onToggle={() => onToggleSection("git")}
            />
          ) : null}
          {segmentAction}
        </div>
        {showParentThread && parentThreadSection && !isParentThreadOnly ? (
          <ParentThreadSectionBody
            section={parentThreadSection}
            isExpanded={isParentThreadExpanded}
          />
        ) : null}
        {showGit ? (
          <AnimatedBody
            collapsedBorder="reserve"
            id={SECTION_IDS.git.body}
            labelledBy={SECTION_IDS.git.toggle}
            isExpanded={isGitExpanded}
          >
            <WorkspaceChangesList
              files={gitSection.changedFiles.files}
              className="max-h-32 px-3 pb-2 pt-1"
              onFileClick={(file) =>
                gitSection.onPromptBannerFileClick({
                  file,
                  section: gitSection.changedFiles,
                })
              }
            />
          </AnimatedBody>
        ) : null}
      </PromptStackCard>
    ) : null;

  if (activeChildThreadsCard && compactContextBanner) {
    return (
      <div className="min-w-0 space-y-2">
        {activeChildThreadsCard}
        {compactContextBanner}
      </div>
    );
  }

  return activeChildThreadsCard ?? compactContextBanner;
}
