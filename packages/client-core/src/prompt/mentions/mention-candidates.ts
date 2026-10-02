import type { PromptMentionSuggestion } from "./types.js";

export interface OrderedMentionSuggestions {
  readonly groups: readonly {
    readonly key: string;
    readonly label: string;
    readonly startIndex: number;
    readonly suggestions: readonly PromptMentionSuggestion[];
  }[];
  readonly suggestions: readonly PromptMentionSuggestion[];
}

const SUPPORTING_MATCH_RANK = 3;
const NO_MATCH_RANK = 4;

export function mentionIdentityMatchRank(
  identities: readonly string[],
  query: string,
): number {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return 0;
  const terms = identities.map((identity) => identity.trim().toLowerCase());
  if (terms.includes(needle)) return 0;
  if (terms.some((term) => term.startsWith(needle))) return 1;
  return terms.some((term) => term.includes(needle)) ? 2 : NO_MATCH_RANK;
}

interface MentionTerms {
  identities: readonly string[];
  supporting?: string | null;
  key: string;
  label: string;
}

function mentionTerms(suggestion: PromptMentionSuggestion): MentionTerms {
  switch (suggestion.kind) {
    case "thread":
      return {
        identities: [
          suggestion.title?.trim() || suggestion.threadId,
          suggestion.threadId,
        ],
        supporting: suggestion.projectName,
        key: "threads",
        label: "Threads",
      };
    case "project":
      return {
        identities: [suggestion.name, suggestion.projectId],
        key: "projects",
        label: "Projects",
      };
    case "section":
      return {
        identities: [suggestion.name, suggestion.sectionId],
        key: "sections",
        label: "Sections",
      };
    case "plugin":
      return {
        identities: [suggestion.title],
        supporting: suggestion.subtitle,
        key: `plugin:${suggestion.pluginId}:${suggestion.providerId}`,
        label: suggestion.providerLabel,
      };
    case "path":
      return {
        identities: [suggestion.name, suggestion.path, suggestion.replacement],
        key: `path:${suggestion.source}`,
        label:
          suggestion.source === "thread-storage"
            ? "Thread storage"
            : "Workspace",
      };
  }
}

export function orderMentionSuggestions(
  suggestions: readonly PromptMentionSuggestion[],
  query: string,
): OrderedMentionSuggestions {
  const needle = query.trim().toLowerCase();
  const byKey = new Map<
    string,
    {
      label: string;
      best: number;
      rows: { suggestion: PromptMentionSuggestion; rank: number }[];
    }
  >();
  for (const suggestion of suggestions) {
    const { identities, supporting, key, label } = mentionTerms(suggestion);
    const identityRank = mentionIdentityMatchRank(identities, needle);
    const rank =
      identityRank === NO_MATCH_RANK &&
      supporting?.trim().toLowerCase().includes(needle)
        ? SUPPORTING_MATCH_RANK
        : identityRank;
    const group = byKey.get(key) ?? { label, best: rank, rows: [] };
    group.best = Math.min(group.best, rank);
    group.rows.push({ suggestion, rank });
    byKey.set(key, group);
  }
  let startIndex = 0;
  const groups = [...byKey]
    .sort(([, left], [, right]) => left.best - right.best)
    .map(([key, group]) => {
      const rows = group.rows
        .sort((left, right) => left.rank - right.rank)
        .map((row) => row.suggestion);
      const ordered = {
        key,
        label: group.label,
        startIndex,
        suggestions: rows,
      };
      startIndex += rows.length;
      return ordered;
    });
  return {
    groups,
    suggestions: groups.flatMap((group) => group.suggestions),
  };
}
