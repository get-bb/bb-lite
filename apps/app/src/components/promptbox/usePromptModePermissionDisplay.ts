import type {
  PromptTextMention,
  ThreadTimelineActivePromptMode,
} from "@bb/domain";
import {
  isPlanModePrompt,
  permissionDisplayForActivePromptMode,
  permissionDisplayForPromptMode,
  shouldDisablePermissionPickerForActivePromptMode,
} from "@bb/client-core";
import type { ExecutionControlsProps } from "@/components/pickers/ModelReasoningPicker";

export function usePromptModePermissionDisplay({
  execution,
  value,
  mentionRanges,
  activePromptMode,
}: {
  execution: ExecutionControlsProps;
  value: string;
  mentionRanges: readonly PromptTextMention[];
  activePromptMode: ThreadTimelineActivePromptMode | null;
}) {
  const planModeCopy = execution.provider.options?.find(
    (option) => option.value === execution.provider.selectedId,
  )?.planModeCopy;
  const promptModeInput = { planModeCopy, value, mentionRanges };
  return {
    permissionDisplayOverride:
      permissionDisplayForActivePromptMode(activePromptMode, planModeCopy) ??
      permissionDisplayForPromptMode(promptModeInput),
    permissionPickerDisabledByPlanMode:
      shouldDisablePermissionPickerForActivePromptMode(activePromptMode) ||
      isPlanModePrompt(promptModeInput),
  };
}
