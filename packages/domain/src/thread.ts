import { z } from "zod";
import { threadCreateOriginSchema } from "./thread-create-origin.js";
import { environmentWorkspaceDisplayKindSchema } from "./environment.js";
import { gitCheckoutRefSchema } from "./git-checkout.js";
import {
  queuedMessageFailureReasonSchema,
  queuedMessagePayloadSchema,
  queuedMessageWaitingOnSchema,
} from "./queued-message.js";
import {
  promptInputSchema,
  permissionModeSchema,
  reasoningLevelSchema,
  serviceTierSchema,
} from "./shared-types.js";
import { threadStatusSchema, threadStatusValues } from "./thread-status.js";
import { threadOriginKindSchema } from "./thread-origin-kind.js";
import { threadVisibilitySchema } from "./thread-visibility.js";
export { threadStatusSchema, threadStatusValues } from "./thread-status.js";
export type { ThreadStatus } from "./thread-status.js";
export { threadOriginKindSchema } from "./thread-origin-kind.js";
export type { ThreadOriginKind } from "./thread-origin-kind.js";

const threadRuntimeDisplayStatusValues = [
  ...threadStatusValues,
  "provisioning",
  "waiting-for-host",
] as const;
const threadRuntimeDisplayStatusSchema = z.enum(
  threadRuntimeDisplayStatusValues,
);
export type ThreadRuntimeDisplayStatus = z.infer<
  typeof threadRuntimeDisplayStatusSchema
>;

export const threadRuntimeStateSchema = z.object({
  displayStatus: threadRuntimeDisplayStatusSchema,
});

export const threadActivityStateSchema = z.object({
  activeWorkflowCount: z.number().int().nonnegative(),
  activeBackgroundAgentCount: z.number().int().nonnegative(),
  activeBackgroundCommandCount: z.number().int().nonnegative(),
  activePlanModeCount: z.number().int().nonnegative(),
  activeGoalCount: z.number().int().nonnegative(),
});
export type ThreadActivityState = z.infer<typeof threadActivityStateSchema>;

const workspaceStateValues = [
  "clean",
  "untracked",
  "dirty_uncommitted",
  "committed_unmerged",
  "dirty_and_committed_unmerged",
] as const;
const workspaceStateSchema = z.enum(workspaceStateValues);

const workspaceFileStatusKindSchema = z.enum([
  "M",
  "A",
  "D",
  "R",
  "C",
  "U",
  "??",
  "?",
]);
export type WorkspaceFileStatusKind = z.infer<
  typeof workspaceFileStatusKindSchema
>;

const workspaceFileStatusSchema = z.object({
  path: z.string(),
  status: workspaceFileStatusKindSchema,
  insertions: z.number().nullable(),
  deletions: z.number().nullable(),
});
export type WorkspaceFileStatus = z.infer<typeof workspaceFileStatusSchema>;

const workspaceCommitSummarySchema = z.object({
  sha: z.string(),
  shortSha: z.string(),
  subject: z.string(),
  authorName: z.string(),
  authoredAt: z.number(),
});
export type WorkspaceCommitSummary = z.infer<
  typeof workspaceCommitSummarySchema
>;

const workspaceChangeStatsSchema = z.object({
  insertions: z.number(),
  deletions: z.number(),
  lineStatsComplete: z.boolean(),
  files: z.array(workspaceFileStatusSchema),
});
export type WorkspaceChangeStats = z.infer<typeof workspaceChangeStatsSchema>;

const workspaceWorkingTreeSchema = workspaceChangeStatsSchema.extend({
  hasUncommittedChanges: z.boolean(),
  state: workspaceStateSchema,
});

const workspaceBranchSchema = z.object({
  currentBranch: z.string().nullable(),
  defaultBranch: z.string(),
});

const workspaceMergeBaseSchema = workspaceChangeStatsSchema.extend({
  mergeBaseBranch: z.string(),
  baseRef: z.string().nullable(),
  aheadCount: z.number(),
  behindCount: z.number(),
  hasCommittedUnmergedChanges: z.boolean(),
  commits: z.array(workspaceCommitSummarySchema),
});

export const workspaceStatusSchema = z.object({
  workingTree: workspaceWorkingTreeSchema,
  checkout: gitCheckoutRefSchema,
  branch: workspaceBranchSchema,
  mergeBase: workspaceMergeBaseSchema.nullable(),
});
export type WorkspaceStatus = z.infer<typeof workspaceStatusSchema>;

export const threadQueuedMessageSchema = z.object({
  id: z.string(),
  origin: threadCreateOriginSchema.nullable(),
  originPluginId: z.string().nullable(),
  initiator: z.enum(["user", "agent", "system"]),
  senderThreadId: z.string().nullable(),
  threadId: z.string(),
  content: z.array(promptInputSchema).min(1),
  model: z.string().min(1),
  reasoningLevel: reasoningLevelSchema,
  permissionMode: permissionModeSchema,
  serviceTier: serviceTierSchema,
  groupWithNext: z.boolean(),
  sendAt: z.number().int().nonnegative().nullable(),
  waitingOn: queuedMessageWaitingOnSchema.nullable(),
  failureReason: queuedMessageFailureReasonSchema.nullable(),
  payload: queuedMessagePayloadSchema,
  editable: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ThreadQueuedMessage = z.infer<typeof threadQueuedMessageSchema>;

export const threadSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  environmentId: z.string().nullable(),
  providerId: z.string(),
  title: z.string().nullable(),
  titleFallback: z.string().nullable(),
  sectionId: z.string().nullable(),
  status: threadStatusSchema,
  parentThreadId: z.string().nullable(),
  lifecycleOwnerThreadId: z.string().nullable(),
  sourceThreadId: z.string().nullable(),
  originKind: threadOriginKindSchema.nullable(),
  originPluginId: z.string().nullable(),
  visibility: threadVisibilitySchema,
  archivedAt: z.number().nullable(),
  pinnedAt: z.number().nullable(),
  deletedAt: z.number().nullable(),
  lastReadAt: z.number().nullable(),
  latestAttentionAt: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Thread = z.infer<typeof threadSchema>;

export const threadWithRuntimeSchema = threadSchema.extend({
  runtime: threadRuntimeStateSchema,
});
export type ThreadWithRuntime = z.infer<typeof threadWithRuntimeSchema>;

export const threadQueuedWorkValues = ["none", "waiting", "failed"] as const;
export const threadQueuedWorkSchema = z.enum(threadQueuedWorkValues);
export type ThreadQueuedWork = z.infer<typeof threadQueuedWorkSchema>;

export const threadListEntrySchema = threadWithRuntimeSchema.extend({
  activity: threadActivityStateSchema,
  queuedWork: threadQueuedWorkSchema,
  pinSortKey: z.string().nullable(),
  hasPendingInteraction: z.boolean(),
  environmentHostId: z.string().nullable(),
  environmentName: z.string().nullable(),
  environmentBranchName: z.string().nullable(),
  environmentPath: z.string().nullable(),
  environmentProviderId: z.string().nullable(),
  environmentIsWorktree: z.boolean().nullable(),
  environmentWorkspaceDisplayKind: environmentWorkspaceDisplayKindSchema,
});
export type ThreadListEntry = z.infer<typeof threadListEntrySchema>;
