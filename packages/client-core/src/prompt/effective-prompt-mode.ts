import {
  promptInputHasCommandMention,
  type ThreadTimelineActivePromptMode,
  type PromptTextMention,
} from "@bb/domain";

interface PromptModeInput {
  mentionRanges: readonly PromptTextMention[];
  planModeCopy: string | undefined;
  value: string;
}

function planPermissionDisplay(planModeCopy: string) {
  return {
    label: "Plan Mode",
    compactLabel: "Plan",
    description: planModeCopy,
  };
}

export function isPlanModePrompt(args: PromptModeInput): boolean {
  const mentions = [...args.mentionRanges];
  return (
    args.planModeCopy !== undefined &&
    promptInputHasCommandMention(
      [{ type: "text", text: args.value, mentions }],
      { trigger: "/", name: "plan" },
    )
  );
}

export function permissionDisplayForPromptMode(args: PromptModeInput) {
  return args.planModeCopy !== undefined && isPlanModePrompt(args)
    ? planPermissionDisplay(args.planModeCopy)
    : undefined;
}

export function permissionDisplayForActivePromptMode(
  activePromptMode: ThreadTimelineActivePromptMode | null | undefined,
  planModeCopy: string | undefined,
) {
  return activePromptMode?.mode === "plan" && planModeCopy !== undefined
    ? planPermissionDisplay(planModeCopy)
    : undefined;
}

export function shouldDisablePermissionPickerForActivePromptMode(
  activePromptMode: ThreadTimelineActivePromptMode | null | undefined,
): boolean {
  return activePromptMode?.mode === "plan";
}
