import { useMemo } from "react";
import type { PromptMentionCommandTrigger } from "@bb/domain";
import {
  filterCommandSuggestions,
  toProviderCommandSuggestion,
  type ProviderCommandSuggestion,
} from "@bb/client-core";
import { threads, useOp } from "@bb/plugin/app";
import { useProjectCommands } from "@bb/app-kit/hooks/queries/project-queries";

const THREAD_COMMAND_TRIGGER: PromptMentionCommandTrigger = "/";
const NO_TRIGGERS: readonly PromptMentionCommandTrigger[] = [];

export interface ThreadProviderCommand {
  name: string;
  description?: string;
  inputHint?: string;
}

export function threadProviderCommandSuggestions({
  commands,
  query,
  trigger,
}: {
  commands: readonly ThreadProviderCommand[] | null | undefined;
  query: string;
  trigger: PromptMentionCommandTrigger | null;
}): ProviderCommandSuggestion[] {
  if (trigger !== THREAD_COMMAND_TRIGGER) {
    return [];
  }
  return filterCommandSuggestions(
    (commands ?? []).map((command) => ({
      kind: "command" as const,
      name: command.name,
      source: "command" as const,
      origin: "user" as const,
      description: command.description ?? null,
      argumentHint: command.inputHint ?? null,
    })),
    query,
  );
}

interface CommandSuggestionPromptAction {
  command?: { trigger: PromptMentionCommandTrigger; name: string };
}

export function useCommandSuggestions(args: {
  projectId: string | undefined;
  providerId: string | undefined;
  commandScope: "new-thread" | "thread";
  skillsTriggers: readonly PromptMentionCommandTrigger[];
  activeTrigger: PromptMentionCommandTrigger | null;
  promptActions?: readonly CommandSuggestionPromptAction[];
  environmentId: string | null;
  hostId?: string | null;
  threadId?: string | null;
  query: string | null;
}) {
  const { activeTrigger: trigger, commandScope, promptActions } = args;
  const threadId = commandScope === "thread" ? (args.threadId ?? null) : null;
  const threadCommandsState = useOp(
    threads.providerCommands,
    { threadId: threadId ?? "" },
    { enabled: threadId !== null },
  );
  const threadCommands =
    threadId === null ? undefined : threadCommandsState.data?.commands;
  const triggers =
    threadCommands !== undefined &&
    threadCommands.length > 0 &&
    !args.skillsTriggers.includes(THREAD_COMMAND_TRIGGER)
      ? [...args.skillsTriggers, THREAD_COMMAND_TRIGGER]
      : args.skillsTriggers;
  const isActive =
    args.projectId !== undefined &&
    args.providerId !== undefined &&
    trigger !== null &&
    triggers.includes(trigger) &&
    args.query !== null;
  const query = args.query?.trim() ?? "";
  const commandsQuery = useProjectCommands(
    {
      projectId: args.projectId,
      providerId: args.providerId,
      environmentId: args.environmentId,
      hostId: args.hostId ?? null,
    },
    {
      enabled:
        isActive && trigger !== null && args.skillsTriggers.includes(trigger),
    },
  );
  const commands = commandsQuery.data?.commands;

  const suggestions = useMemo<ProviderCommandSuggestion[]>(() => {
    if (!isActive) return [];
    const fromActions = filterCommandSuggestions(
      (promptActions ?? []).flatMap((action) =>
        action.command?.trigger === trigger
          ? [
              {
                kind: "command" as const,
                name: action.command.name,
                source: "command" as const,
                origin: "user" as const,
                description: null,
                argumentHint: null,
              },
            ]
          : [],
      ),
      query,
    );
    const discovered = filterCommandSuggestions(
      (commands ?? [])
        .map(toProviderCommandSuggestion)
        .filter(
          (suggestion) =>
            (trigger !== "$" || suggestion.source === "skill") &&
            (commandScope === "thread" ||
              suggestion.source !== "command" ||
              suggestion.origin !== "builtin" ||
              suggestion.name !== "compact"),
        ),
      query,
    );
    const live = threadProviderCommandSuggestions({
      commands: threadCommands,
      query,
      trigger,
    });
    const seen = new Set<string>();
    return [...fromActions, ...live, ...discovered].filter((suggestion) => {
      const key = `${suggestion.source}:${suggestion.name}`;
      return !seen.has(key) && seen.add(key);
    });
  }, [
    commandScope,
    commands,
    isActive,
    promptActions,
    query,
    threadCommands,
    trigger,
  ]);

  return {
    triggers: triggers.length === 0 ? NO_TRIGGERS : triggers,
    suggestions,
    isLoading:
      isActive &&
      suggestions.length === 0 &&
      commands === undefined &&
      args.skillsTriggers.includes(trigger ?? THREAD_COMMAND_TRIGGER) &&
      (commandsQuery.isPending || commandsQuery.isFetching),
    isError: isActive && commandsQuery.isError,
  };
}
