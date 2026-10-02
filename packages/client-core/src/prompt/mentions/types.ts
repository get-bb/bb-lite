import { fuzzyMatchText } from "@bb/fuzzy-match";
import {
  providerCommandSectionRank,
  type ProviderCommand,
  type ProviderCommandOrigin,
  type ProviderCommandSource,
} from "@bb/server-contract";
import type { PromptMentionCommandTrigger } from "@bb/domain";
import type { PluginMentionTrigger } from "./plugin-mention-triggers.js";
import type { OrderedMentionSuggestions } from "./mention-candidates.js";

type PromptPathMentionSource = "workspace" | "thread-storage";
type PromptPathMentionEntryKind = "file" | "directory";

export type ThreadMentionRelation =
  | "parent"
  | "child"
  | "same-parent"
  | "same-environment";

export type PromptMentionSuggestion =
  | {
      kind: "path";
      source: PromptPathMentionSource;
      entryKind: PromptPathMentionEntryKind;
      path: string;
      name: string;
      replacement: string;
    }
  | {
      kind: "thread";
      path: string;
      replacement: string;
      projectId: string;
      projectName?: string;
      threadId: string;
      title?: string;
      relation: ThreadMentionRelation | null;
    }
  | {
      kind: "project";
      path: string;
      replacement: string;
      projectId: string;
      name: string;
    }
  | {
      kind: "section";
      path: string;
      replacement: string;
      sectionId: string;
      name: string;
    }
  | {
      kind: "plugin";
      pluginId: string;
      providerId: string;
      itemId: string;
      providerLabel: string;
      title: string;
      subtitle: string | null;
      icon: string | null;
      replacement: string;
    };

export interface ProviderCommandSuggestion {
  kind: "command";
  name: string;
  source: ProviderCommandSource;
  origin: ProviderCommandOrigin;
  description: string | null;
  argumentHint: string | null;
  pluginId?: string;
}

export function toProviderCommandSuggestion(
  command: ProviderCommand,
): ProviderCommandSuggestion {
  const { name, source, origin, description, argumentHint, pluginId } = command;
  return {
    kind: "command",
    name,
    source,
    origin,
    description,
    argumentHint,
    ...(pluginId !== undefined ? { pluginId } : {}),
  };
}

function matchingCommandNames(
  suggestions: readonly ProviderCommandSuggestion[],
  query: string,
): Set<ProviderCommandSuggestion> {
  return new Set(
    fuzzyMatchText({
      items: suggestions,
      query,
      getText: (suggestion) => suggestion.name,
      limit: suggestions.length,
    }).map((match) => match.item),
  );
}

export function filterCommandSuggestions(
  suggestions: readonly ProviderCommandSuggestion[],
  query: string,
): ProviderCommandSuggestion[] {
  const needle = query.trim().toLowerCase();
  const nameMatches = matchingCommandNames(suggestions, needle);
  return suggestions.filter(
    (suggestion) =>
      nameMatches.has(suggestion) ||
      [suggestion.description ?? "", suggestion.argumentHint ?? ""].some(
        (text) => text.toLowerCase().includes(needle),
      ),
  );
}

function commandMatchRank(
  suggestion: ProviderCommandSuggestion,
  needle: string,
  nameMatches: ReadonlySet<ProviderCommandSuggestion>,
): number {
  const name = suggestion.name.toLowerCase();
  if (name === needle) return 0;
  const separator = suggestion.source === "skill" ? name.lastIndexOf(":") : -1;
  const names = separator < 0 ? [name] : [name, name.slice(separator + 1)];
  if (names.includes(needle)) return 1;
  if (names.some((candidate) => candidate.startsWith(needle))) return 2;
  if (names.some((candidate) => candidate.includes(needle))) return 3;
  return nameMatches.has(suggestion) ? 4 : 5;
}

export function orderCommandSuggestions(
  suggestions: readonly ProviderCommandSuggestion[],
  query: string,
): ProviderCommandSuggestion[] {
  const needle = query.trim().toLowerCase();
  const nameMatches = matchingCommandNames(suggestions, needle);
  const ranked = suggestions
    .map((suggestion) => ({
      suggestion,
      rank: commandMatchRank(suggestion, needle, nameMatches),
      section: providerCommandSectionRank(suggestion),
    }))
    .sort(
      (left, right) => left.rank - right.rank || left.section - right.section,
    );
  return [...new Set(ranked.map((entry) => entry.section))].flatMap((section) =>
    ranked
      .filter((entry) => entry.section === section)
      .map((entry) => entry.suggestion),
  );
}

export type TypeaheadTrigger =
  | { char: PluginMentionTrigger; kind: "mention" }
  | { char: PromptMentionCommandTrigger; kind: "command" };

export type ActiveTrigger = TypeaheadTrigger & {
  query: string;
  from: number;
  to: number;
};

export type TypeaheadMenuState =
  | {
      trigger: "mention";
      state:
        | { kind: "hint" | "loading" | "error" }
        | { kind: "results"; results: OrderedMentionSuggestions };
    }
  | {
      trigger: "command";
      state:
        | { kind: "loading" | "error" }
        | {
            kind: "results";
            suggestions: readonly ProviderCommandSuggestion[];
          };
    };
