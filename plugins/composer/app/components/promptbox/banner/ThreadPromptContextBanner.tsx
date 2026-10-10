import {
  CONTEXT_CARD_TOGGLE_CLASS,
  CONTEXT_CARD_CHEVRON_CLASS,
} from "@bb/shared-ui/chrome-style-tokens";
import {
  machineRemovalDescriptions,
  machineRemovalLabels,
  type MachineRemovalStatus,
} from "@bb/app-kit/lib/machine-removal-display";
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
} from "../../pickers/BranchPicker";
import {
  AnimatedBody,
  BannerActionSlot,
  PromptStackCard,
  PromptStackCardChevron,
  PROMPT_BANNER_ACTION_BUTTON_CLASS,
  PROMPT_STACK_CARD_HEADER_BUTTON_CLASS,
  PROMPT_STACK_CARD_ROW_HEIGHT,
  PROMPT_STACK_INLAY_INSET_CLASS,
  PROMPT_STACK_INLAY_SEGMENT_CLASS,
} from "./PromptStackCard";
import {
  activityIconClass,
  activityRowClass,
} from "@bb/shared-ui/activity-row-styles";
import { WorkspaceChangesList } from "@bb/app-kit/components/thread/WorkspaceChangesList";
import {
  formatChangeSummary,
  renderChangeSummary,
  toChangeTally,
  type WorkspaceChangedFileSelection,
  type WorkspaceChangedFilesSection,
} from "@bb/app-kit/components/workspace/workspace-change-summary";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  ThreadContextActions,
  ThreadContextSegments,
  useHasThreadContextSegments,
} from "../composer-slots";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import {
  ThreadTitle,
  useThreadTitleDisplayText,
} from "@bb/app-kit/components/thread/ThreadTitleMentions";

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

export interface ThreadPromptParentThreadSection {
  parentThreadTitle: string;
  href: string;
  relationship: "parent" | "fork";
}

export interface ThreadPromptChildThreadsSection {
  items: readonly {
    id: string;
    title: string;
    href: string;
    hasPendingInteraction: boolean;
  }[];
}

export function isThreadDisplayStatusBannerActive(
  status: ThreadRuntimeDisplayStatus,
): boolean {
  return (
    status === "active" ||
    status === "provisioning" ||
    status === "starting" ||
    status === "waiting-for-host"
  );
}

export type ThreadPromptContextBannerExpandedSection =
  | "git"
  | "parentThread"
  | "childThreads"
  | "status";

interface ThreadPromptContextBannerProps {
  threadId?: string;
  gitSection: {
    changedFiles: WorkspaceChangedFilesSection;
    mergeBase: ContextBannerMergeBaseConfig | null;
    onPromptBannerFileClick: (selection: WorkspaceChangedFileSelection) => void;
  } | null;
  gitSectionPending: boolean;
  archivedSection: {
    archivedAt: number;
    onUnarchive?: () => void;
    unarchivePending?: boolean;
  } | null;
  environmentGoneSection: {
    status: Extract<EnvironmentStatus, "destroyed"> | MachineRemovalStatus;
  } | null;
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
const PARENT_SECTION_COPY: Record<
  ThreadPromptParentThreadSection["relationship"],
  { verb: string; bodyLead: string; ariaPrefix: string; icon: IconName }
> = {
  parent: {
    verb: "Parent",
    bodyLead: "This thread is a child of ",
    ariaPrefix: "Parent thread",
    icon: "UserRound",
  },
  fork: {
    verb: "Forked from",
    bodyLead: "This thread was forked from ",
    ariaPrefix: "Forked from",
    icon: "Fork",
  },
};
const PARENT_THREAD_TITLE_CLASS =
  "text-foreground/90 underline underline-offset-2";
const CARD_STYLE = { minHeight: PROMPT_STACK_CARD_ROW_HEIGHT };
const SEGMENT_ROW_CLASS = cn(
  "flex items-center gap-0.5 text-xs text-muted-foreground",
  PROMPT_STACK_INLAY_INSET_CLASS,
);
const CONTRIBUTED_ONLY_CARD_CLASS = "[&:not(:has([data-bb-plugin]>*))]:hidden";
const CONTRIBUTED_ACTION_ROW_CLASS =
  "[&:has([data-context-actions]_[data-bb-plugin]>*)_[data-context-merge-base]]:hidden";
const toggleId = (section: string) => `thread-prompt-banner-${section}-toggle`;
const bodyId = (section: string) => `thread-prompt-banner-${section}-body`;

function SectionToggleButton({
  section,
  ariaLabel,
  icon,
  label,
  isExpanded,
  onToggle,
}: {
  section: string;
  ariaLabel?: string;
  icon: IconName;
  label: ReactNode;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      id={toggleId(section)}
      aria-expanded={isExpanded}
      aria-controls={bodyId(section)}
      aria-label={ariaLabel}
      onClick={onToggle}
      className={cn(
        CONTEXT_CARD_TOGGLE_CLASS,
        PROMPT_STACK_INLAY_SEGMENT_CLASS,
        "min-w-0 overflow-hidden",
        label !== null ? "gap-1.5" : "gap-0",
        isExpanded ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <Icon name={icon} className="size-3.5 shrink-0" aria-hidden="true" />
      {label !== null ? (
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

function SectionBody({
  section,
  isExpanded,
  children,
}: {
  section: string;
  isExpanded: boolean;
  children: ReactNode;
}) {
  return (
    <AnimatedBody
      collapsedBorder="reserve"
      id={bodyId(section)}
      labelledBy={toggleId(section)}
      isExpanded={isExpanded}
    >
      {children}
    </AnimatedBody>
  );
}

function ParentThreadSegment({
  section,
  inline,
  isExpanded,
  onToggle,
}: {
  section: ThreadPromptParentThreadSection;
  inline: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const copy = PARENT_SECTION_COPY[section.relationship];
  const ariaLabel = `${copy.ariaPrefix} ${useThreadTitleDisplayText(
    section.parentThreadTitle,
  )}`;
  if (!inline) {
    return (
      <SectionToggleButton
        section="parent-thread"
        ariaLabel={ariaLabel}
        icon={copy.icon}
        label={null}
        isExpanded={isExpanded}
        onToggle={onToggle}
      />
    );
  }
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-xs",
        PROMPT_STACK_INLAY_SEGMENT_CLASS,
      )}
      title={ariaLabel}
    >
      <Icon name={copy.icon} className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">
        {copy.verb}{" "}
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

function ParentThreadSectionBody({
  section,
  isExpanded,
}: {
  section: ThreadPromptParentThreadSection;
  isExpanded: boolean;
}) {
  return (
    <SectionBody section="parent-thread" isExpanded={isExpanded}>
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
    </SectionBody>
  );
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
  const items = [...childThreadsSection.items].sort(
    (left, right) =>
      Number(right.hasPendingInteraction) - Number(left.hasPendingInteraction),
  );
  const primary = items[0];
  const primaryTitle = useThreadTitleDisplayText(primary?.title ?? "");
  if (!primary) {
    return null;
  }
  const pendingCount = items.filter(
    (item) => item.hasPendingInteraction,
  ).length;
  const needsApproval = pendingCount > 0;
  const groupLabel = needsApproval
    ? `${pendingCount} child ${pendingCount === 1 ? "thread needs" : "threads need"} input`
    : `${items.length} active child ${items.length === 1 ? "thread" : "threads"}`;
  return (
    <PromptStackCard
      ariaLabel="Child threads"
      className="overflow-hidden"
      style={CARD_STYLE}
    >
      <div className="flex items-center">
        <button
          type="button"
          id={toggleId("child-threads")}
          aria-expanded={isExpanded}
          aria-controls={bodyId("child-threads")}
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
          {items.length > 1 ? (
            <span className="shrink-0 text-muted-foreground">
              +{items.length - 1} more
            </span>
          ) : null}
          <PromptStackCardChevron
            isExpanded={isExpanded}
            className="text-muted-foreground"
          />
        </button>
      </div>
      <SectionBody section="child-threads" isExpanded={isExpanded}>
        <ul className="max-h-40 space-y-0.5 overflow-y-auto px-3 pb-2 pt-1.5">
          {items.map((item) => (
            <li key={item.id} className="text-xs">
              <NavLink
                to={item.href}
                className="flex min-w-0 items-center gap-2 py-0.5 text-foreground/90 underline-offset-2 hover:underline"
              >
                <Icon
                  name={
                    item.hasPendingInteraction
                      ? "CircleQuestion"
                      : "ChevronDown"
                  }
                  className={
                    item.hasPendingInteraction
                      ? "size-3.5 shrink-0 text-muted-foreground/75 no-underline"
                      : "size-3.5 shrink-0 rotate-45 text-subtle-foreground no-underline"
                  }
                  aria-hidden="true"
                />
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
      </SectionBody>
    </PromptStackCard>
  );
}

export function ThreadPromptContextBanner({
  threadId,
  gitSection,
  gitSectionPending,
  archivedSection,
  environmentGoneSection,
  parentThreadSection,
  childThreadsSection,
  expandedSection,
  onToggleSection,
}: ThreadPromptContextBannerProps) {
  const hasContextSegments = useHasThreadContextSegments();
  const isParentThreadExpanded =
    expandedSection === "parentThread" && parentThreadSection !== null;
  const parentSegment = (inline: boolean) =>
    parentThreadSection ? (
      <ParentThreadSegment
        section={parentThreadSection}
        inline={inline}
        isExpanded={isParentThreadExpanded}
        onToggle={() => onToggleSection("parentThread")}
      />
    ) : null;
  const parentBody = parentThreadSection ? (
    <ParentThreadSectionBody
      section={parentThreadSection}
      isExpanded={isParentThreadExpanded}
    />
  ) : null;

  if (archivedSection || environmentGoneSection) {
    const goneStatus = environmentGoneSection?.status;
    const statusLabel =
      goneStatus === undefined
        ? "Thread is archived"
        : goneStatus === "destroyed"
          ? "Environment unavailable"
          : machineRemovalLabels[goneStatus];
    const description =
      goneStatus === undefined
        ? null
        : goneStatus === "destroyed"
          ? "The workspace was removed. Sending a message restores it."
          : machineRemovalDescriptions[goneStatus];
    const statusIcon = goneStatus === undefined ? "Archive" : "CircleX";
    const isStatusExpanded =
      expandedSection === "status" && description !== null;
    const action = archivedSection?.onUnarchive
      ? {
          pending: Boolean(archivedSection.unarchivePending),
          label: "Unarchive",
          pendingLabel: "Unarchiving...",
          onClick: archivedSection.onUnarchive,
        }
      : null;
    return (
      <PromptStackCard
        ariaLabel="Thread history"
        className="overflow-hidden"
        style={CARD_STYLE}
      >
        <div className={SEGMENT_ROW_CLASS}>
          {parentSegment(false)}
          {description === null ? (
            <div
              className={cn(
                "flex min-w-0 items-center gap-1.5 text-xs",
                PROMPT_STACK_INLAY_SEGMENT_CLASS,
              )}
              role="status"
              aria-label={statusLabel}
            >
              <Icon
                name={statusIcon}
                className="size-3.5 shrink-0"
                aria-hidden="true"
              />
              <span className="min-w-0 truncate" aria-hidden="true">
                {statusLabel}
              </span>
            </div>
          ) : (
            <SectionToggleButton
              section="status"
              icon={statusIcon}
              label={statusLabel}
              isExpanded={isStatusExpanded}
              onToggle={() => onToggleSection("status")}
            />
          )}
          {action && parentThreadSection === null ? (
            <BannerActionSlot>
              <button
                type="button"
                className={PROMPT_BANNER_ACTION_BUTTON_CLASS}
                onClick={action.onClick}
                disabled={action.pending}
              >
                {action.pending ? action.pendingLabel : action.label}
              </button>
            </BannerActionSlot>
          ) : null}
        </div>
        {description === null ? null : (
          <SectionBody section="status" isExpanded={isStatusExpanded}>
            <p className="px-3 pb-2 pt-1.5 text-xs leading-relaxed text-muted-foreground">
              {description}
            </p>
          </SectionBody>
        )}
        {parentBody}
      </PromptStackCard>
    );
  }
  if (gitSectionPending) {
    return null;
  }
  const isGitExpanded = expandedSection === "git" && gitSection !== null;
  const activeChildThreadsCard =
    childThreadsSection !== null && childThreadsSection.items.length > 0 ? (
      <ActiveChildThreadsCard
        childThreadsSection={childThreadsSection}
        isExpanded={expandedSection === "childThreads"}
        onToggle={() => onToggleSection("childThreads")}
      />
    ) : null;
  const gitTally = gitSection
    ? toChangeTally(gitSection.changedFiles.stats)
    : null;
  const gitSummaryPrefix = gitSection
    ? KIND_PREFIX[gitSection.changedFiles.kind]
    : "";
  const mergeBase = parentThreadSection ? null : gitSection?.mergeBase;
  const mergeBaseCandidates = mergeBase
    ? getMergeBaseBranchCandidateGroups({
        mergeBaseBranch: mergeBase.branch,
        mergeBaseBranchRef: mergeBase.branchRef,
        mergeBaseBranchOptions: mergeBase.options,
        remoteMergeBaseBranchOptions: mergeBase.remoteOptions,
      })
    : null;

  const contributed = hasContextSegments && threadId !== undefined;
  const hasOwnSegment = parentThreadSection !== null || gitSection !== null;
  const compactContextBanner =
    hasOwnSegment || contributed ? (
      <PromptStackCard
        ariaLabel="Thread context before sending"
        className={cn(
          "overflow-hidden",
          !hasOwnSegment && CONTRIBUTED_ONLY_CARD_CLASS,
        )}
        style={CARD_STYLE}
      >
        <div className={cn(SEGMENT_ROW_CLASS, CONTRIBUTED_ACTION_ROW_CLASS)}>
          {parentSegment(gitSection === null && !contributed)}
          {contributed ? <ThreadContextSegments threadId={threadId} /> : null}
          {gitSection && gitTally ? (
            <SectionToggleButton
              section="git"
              icon="FileDiff"
              label={
                <>
                  {gitSummaryPrefix} · {renderChangeSummary(gitTally)}
                </>
              }
              ariaLabel={`Changed files: ${gitSummaryPrefix}, ${formatChangeSummary(gitTally)}`}
              isExpanded={isGitExpanded}
              onToggle={() => onToggleSection("git")}
            />
          ) : null}
          {contributed ? (
            <div
              data-context-actions=""
              className="ml-auto hidden shrink-0 items-center gap-1.5 pr-2 has-[[data-bb-plugin]>*]:flex"
            >
              <ThreadContextActions threadId={threadId} />
            </div>
          ) : null}
          {mergeBase && mergeBaseCandidates ? (
            <BannerActionSlot hideInCompact>
              <Icon
                name="GitMerge"
                className="size-3.5 shrink-0"
                aria-hidden="true"
              />
              <span className="shrink-0">Merge base</span>
              <BranchPicker
                value={mergeBase.branch}
                options={mergeBaseCandidates.options}
                remoteOptions={mergeBaseCandidates.remoteOptions}
                loading={mergeBase.optionsLoading}
                onChange={mergeBase.onChange}
                onOpenChange={mergeBase.onPickerOpenChange}
                onSearchQueryChange={mergeBase.onSearchQueryChange}
                className="max-w-[10rem]"
                muted
                popoverAlign="end"
              />
            </BannerActionSlot>
          ) : null}
        </div>
        {gitSection ? parentBody : null}
        {gitSection ? (
          <SectionBody section="git" isExpanded={isGitExpanded}>
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
          </SectionBody>
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
