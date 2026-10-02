import { useState } from "react";
import type {
  PromptMentionCommandTrigger,
  ProviderComposerAction,
} from "@bb/domain";
import { buildProviderPromptActionProps } from "@bb/client-core";
import type { TypeaheadConfig } from "@/components/promptbox/PromptBoxInternal";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import { useCommandSuggestions } from "@/hooks/useCommandSuggestions";
import { usePromptMentions } from "@/hooks/usePromptMentions";

export function usePromptTypeahead({
  projectId,
  mentionsProjectId,
  providerId,
  commandScope,
  environmentId,
  hostId,
  currentThreadId,
  composerActions,
  resolveMentionLink,
}: {
  projectId: string;
  mentionsProjectId: string | undefined;
  providerId: string;
  commandScope: "new-thread" | "thread";
  environmentId: string | null;
  hostId?: string | null;
  currentThreadId?: string;
  composerActions: readonly ProviderComposerAction[];
  resolveMentionLink: PromptMentionLinkResolver;
}) {
  const mentions = usePromptMentions(mentionsProjectId, {
    currentThreadId,
    environmentId,
    hostId,
  });
  const [commandState, setCommandState] = useState<{
    query: string | null;
    trigger: PromptMentionCommandTrigger | null;
  }>({ query: null, trigger: null });
  const { promptActions, skillsTriggers } =
    buildProviderPromptActionProps(composerActions);
  const commands = useCommandSuggestions({
    projectId,
    providerId,
    commandScope,
    skillsTriggers,
    activeTrigger: commandState.trigger,
    promptActions,
    environmentId,
    hostId,
    query: commandState.query,
  });
  const typeahead: TypeaheadConfig = {
    mention: {
      triggers: mentions.triggers,
      results: mentions.results,
      isLoading: mentions.isLoading,
      isError: mentions.isError,
      onQueryChange: mentions.setQuery,
      resolveLink: resolveMentionLink,
    },
    command: {
      triggers: commands.triggers,
      suggestions: commands.suggestions,
      isLoading: commands.isLoading,
      isError: commands.isError,
      onQueryChange: (query, trigger) => setCommandState({ query, trigger }),
    },
  };
  return { typeahead, promptActions };
}
