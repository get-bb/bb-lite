import type {
  ProviderComposerCommand,
  PromptMentionCommandTrigger,
  ProviderComposerAction,
} from "@bb/domain";

export type ProviderPromptActionCommand = ProviderComposerCommand;

interface ProviderPromptAction {
  kind: "goal" | "skills";
  text: string;
  command?: ProviderPromptActionCommand;
}

export function buildProviderPromptActionProps(
  composerActions: readonly ProviderComposerAction[],
): {
  skillsTriggers: readonly PromptMentionCommandTrigger[];
  promptActions: readonly ProviderPromptAction[];
} {
  const promptActions: ProviderPromptAction[] = [];
  const skillsTriggers: PromptMentionCommandTrigger[] = [];
  for (const action of composerActions) {
    if (action.kind !== "skills") {
      const { command } = action;
      const text = `${command.trigger}${command.name}${command.trailingText}`;
      promptActions.push({ kind: action.kind, command, text });
      continue;
    }
    skillsTriggers.push(action.trigger);
    if (!promptActions.some((candidate) => candidate.kind === "skills")) {
      promptActions.push({ kind: "skills", text: action.trigger });
    }
  }
  return { skillsTriggers, promptActions };
}
