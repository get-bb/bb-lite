import { callPart, part } from "@bb/app-kit/plugins/parts";
import type * as BranchPickerModule from "./app/components/pickers/BranchPicker";
import type * as ParentThreadPickerModule from "./app/components/pickers/ParentThreadPicker";
import type * as FollowUpPromptBoxModule from "./app/components/promptbox/FollowUpPromptBox";
import type * as ThreadEnvironmentSummaryModule from "./app/components/promptbox/ThreadEnvironmentSummary";
import type * as QueuedMessagesListModule from "./app/components/promptbox/banner/QueuedMessagesList";
import type * as ThreadBackgroundCommandsCardModule from "./app/components/promptbox/banner/ThreadBackgroundCommandsCard";
import type * as ThreadModelFallbackCardModule from "./app/components/promptbox/banner/ThreadModelFallbackCard";
import type * as ThreadPrivateMachineCardModule from "./app/components/promptbox/banner/ThreadPrivateMachineCard";
import type * as ThreadPromptContextBannerModule from "./app/components/promptbox/banner/ThreadPromptContextBanner";
import type * as ThreadTodoCardModule from "./app/components/promptbox/banner/ThreadTodoCard";
import type * as ThreadWorkflowCardModule from "./app/components/promptbox/banner/ThreadWorkflowCard";
import type * as UseDraftAttachmentUploadsModule from "./app/components/promptbox/useDraftAttachmentUploads";
import type * as UsePromptTypeaheadModule from "./app/components/promptbox/usePromptTypeahead";
import type * as UseThreadCreationOptionsModule from "./app/hooks/useThreadCreationOptions";
import type * as RootComposeViewModule from "./app/views/RootComposeView";
import type * as ModelReasoningPickerModule from "./app/components/pickers/ModelReasoningPicker";
import type * as PermissionModePickerModule from "./app/components/pickers/PermissionModePicker";
import type * as NewThreadComposerModule from "./app/components/promptbox/NewThreadComposer";

export type { FollowUpPromptBoxProps } from "./app/components/promptbox/FollowUpPromptBox";
export type {
  QueuedMessageEditRequest,
  QueuedMessageInlineEditor,
  QueuedMessageProcessingAction,
} from "./app/components/promptbox/banner/QueuedMessagesList";
export type {
  ContextBannerMergeBaseConfig,
  ThreadPromptChildThreadsSection,
  ThreadPromptContextBannerExpandedSection,
  ThreadPromptParentThreadSection,
} from "./app/components/promptbox/banner/ThreadPromptContextBanner";

export const BranchPicker = part<typeof BranchPickerModule.BranchPicker>(
  "composer",
  "BranchPicker",
);
export const getMergeBaseBranchCandidateGroups = callPart<
  typeof BranchPickerModule.getMergeBaseBranchCandidateGroups
>("composer", "getMergeBaseBranchCandidateGroups");
export const ParentThreadPicker = part<
  typeof ParentThreadPickerModule.ParentThreadPicker
>("composer", "ParentThreadPicker");
export const FollowUpPromptBox = part<
  typeof FollowUpPromptBoxModule.FollowUpPromptBox
>("composer", "FollowUpPromptBox");
export const ThreadEnvironmentSummary = part<
  typeof ThreadEnvironmentSummaryModule.ThreadEnvironmentSummary
>("composer", "ThreadEnvironmentSummary");
export const QueuedMessagesList = part<
  typeof QueuedMessagesListModule.QueuedMessagesList
>("composer", "QueuedMessagesList");
export const ThreadBackgroundCommandsCard = part<
  typeof ThreadBackgroundCommandsCardModule.ThreadBackgroundCommandsCard
>("composer", "ThreadBackgroundCommandsCard");
export const ThreadModelFallbackCard = part<
  typeof ThreadModelFallbackCardModule.ThreadModelFallbackCard
>("composer", "ThreadModelFallbackCard");
export const ThreadPrivateMachineCard = part<
  typeof ThreadPrivateMachineCardModule.ThreadPrivateMachineCard
>("composer", "ThreadPrivateMachineCard");
export const ThreadPromptContextBanner = part<
  typeof ThreadPromptContextBannerModule.ThreadPromptContextBanner
>("composer", "ThreadPromptContextBanner");
export const isThreadDisplayStatusBannerActive = callPart<
  typeof ThreadPromptContextBannerModule.isThreadDisplayStatusBannerActive
>("composer", "isThreadDisplayStatusBannerActive");
export const ThreadTodoCard = part<typeof ThreadTodoCardModule.ThreadTodoCard>(
  "composer",
  "ThreadTodoCard",
);
export const ThreadWorkflowCard = part<
  typeof ThreadWorkflowCardModule.ThreadWorkflowCard
>("composer", "ThreadWorkflowCard");
export const useDraftAttachmentUploads = callPart<
  typeof UseDraftAttachmentUploadsModule.useDraftAttachmentUploads
>("composer", "useDraftAttachmentUploads");
export const usePromptTypeahead = callPart<
  typeof UsePromptTypeaheadModule.usePromptTypeahead
>("composer", "usePromptTypeahead");
export const useThreadCreationOptions = callPart<
  typeof UseThreadCreationOptionsModule.useThreadCreationOptions
>("composer", "useThreadCreationOptions");
export const LegacyProjectComposeRedirect = part<
  typeof RootComposeViewModule.LegacyProjectComposeRedirect
>("composer", "LegacyProjectComposeRedirect");
export const RootComposeView = part<
  typeof RootComposeViewModule.RootComposeView
>("composer", "RootComposeView");
export const ModelReasoningPicker = part<
  typeof ModelReasoningPickerModule.ModelReasoningPicker
>("composer", "ModelReasoningPicker");
export const PermissionModePicker = part<
  typeof PermissionModePickerModule.PermissionModePicker
>("composer", "PermissionModePicker");
export const useNewThreadComposer = callPart<
  typeof NewThreadComposerModule.useNewThreadComposer
>("composer", "useNewThreadComposer");
