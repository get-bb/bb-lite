import { useMemo } from "react";
import type { PromptMentionCommandTrigger } from "@bb/domain";
import {
  filterCommandSuggestions,
  toProviderCommandSuggestion,
  type ProviderCommandSuggestion,
} from "@bb/client-core";
import { useProjectCommands } from "@bb/app-kit/hooks/queries/project-queries";

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
  query: string | null;
}) {
  const { activeTrigger: trigger, commandScope, promptActions } = args;
  const isActive =
    args.projectId !== undefined &&
    args.providerId !== undefined &&
    trigger !== null &&
    args.skillsTriggers.includes(trigger) &&
    args.query !== null;
  const query = args.query?.trim() ?? "";
  const commandsQuery = useProjectCommands(
    {
      projectId: args.projectId,
      providerId: args.providerId,
      environmentId: args.environmentId,
      hostId: args.hostId ?? null,
    },
    { enabled: isActive },
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
    const seen = new Set<string>();
    return [...fromActions, ...discovered].filter((suggestion) => {
      const key = `${suggestion.source}:${suggestion.name}`;
      return !seen.has(key) && seen.add(key);
    });
  }, [commandScope, commands, isActive, promptActions, query, trigger]);

  return {
    triggers: args.skillsTriggers,
    suggestions,
    isLoading:
      isActive &&
      suggestions.length === 0 &&
      commands === undefined &&
      (commandsQuery.isPending || commandsQuery.isFetching),
    isError: isActive && commandsQuery.isError,
  };
}
