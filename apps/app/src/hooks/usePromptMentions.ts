import { useCallback, useMemo, useState } from "react";
import { fuzzyMatchText } from "@bb/fuzzy-match";
import { PERSONAL_PROJECT_ID, type Thread } from "@bb/domain";
import {
  compareCodepoint,
  DEFAULT_PLUGIN_MENTION_TRIGGER,
  mentionIdentityMatchRank,
  orderMentionSuggestions,
  PLUGIN_MENTION_TRIGGER_VALUES,
  type PluginMentionTrigger,
  type PromptMentionSuggestion,
  type ThreadMentionRelation,
} from "@bb/client-core";
import { useResolveThreadTitle } from "@/components/thread/ThreadTitleMentions";
import {
  usePluginContributions,
  usePluginMentionSearch,
} from "./queries/plugin-contribution-queries";
import { useSidebarNavigation } from "./queries/sidebar-navigation-query";
import { useThreadMentionCandidates } from "./queries/thread-queries";
import { useDebouncedValue } from "./useDebouncedValue";
import {
  PATH_SUGGESTION_DEBOUNCE_MS,
  usePathSuggestions,
} from "./usePathSuggestions";

const SOURCE_LIMIT = 8;
const NO_THREADS: readonly Thread[] = [];

interface ThreadMentionArgs {
  threads: readonly Thread[];
  query: string;
  currentProjectId: string | undefined;
  currentThreadId: string | undefined;
  currentEnvironmentId: string | null;
  projectNamesById: ReadonlyMap<string, string>;
  resolveTitle: (title: string) => string;
}

function threadTitle(thread: Thread): string | undefined {
  return thread.title?.trim() || thread.titleFallback?.trim() || undefined;
}

function threadMentionSuggestions(
  args: ThreadMentionArgs,
): PromptMentionSuggestion[] {
  const current = args.threads.find(
    (thread) => thread.id === args.currentThreadId,
  );
  const parentId = current?.parentThreadId ?? null;
  const projectId = args.currentProjectId ?? current?.projectId;
  const environmentId =
    args.currentEnvironmentId ?? current?.environmentId ?? null;
  const relationOf = (thread: Thread): ThreadMentionRelation | null => {
    if (parentId !== null && thread.id === parentId) return "parent";
    if (args.currentThreadId && thread.parentThreadId === args.currentThreadId)
      return "child";
    if (parentId !== null && thread.parentThreadId === parentId)
      return "same-parent";
    return environmentId !== null && thread.environmentId === environmentId
      ? "same-environment"
      : null;
  };
  const candidates = args.threads.filter(
    (thread) =>
      thread.id !== args.currentThreadId && thread.visibility !== "hidden",
  );
  return fuzzyMatchText({
    items: candidates,
    query: args.query,
    getText: (thread) => threadTitle(thread) ?? thread.id,
    getAliases: (thread) => {
      const title = threadTitle(thread);
      const resolved = title === undefined ? title : args.resolveTitle(title);
      return resolved === undefined || resolved === title
        ? [thread.id]
        : [thread.id, resolved];
    },
    limit: candidates.length,
  })
    .map(({ item: thread, score }) => {
      const title = threadTitle(thread);
      const relation = relationOf(thread);
      const isOtherProject =
        thread.projectId !== PERSONAL_PROJECT_ID &&
        thread.projectId !== projectId;
      const projectName = isOtherProject
        ? args.projectNamesById.get(thread.projectId)
        : undefined;
      return {
        thread,
        score,
        matchRank: mentionIdentityMatchRank(
          [title ?? thread.id, thread.id],
          args.query,
        ),
        relationRank:
          relation === "parent" || relation === "child"
            ? 0
            : relation === "same-parent"
              ? 1
              : relation === "same-environment"
                ? 2
                : projectId !== undefined && thread.projectId === projectId
                  ? 3
                  : 4,
        suggestion: {
          kind: "thread" as const,
          path: `thread:${thread.id}`,
          replacement: `thread:${thread.id}`,
          projectId: thread.projectId,
          ...(projectName ? { projectName } : {}),
          threadId: thread.id,
          title,
          relation,
        },
      };
    })
    .sort(
      (left, right) =>
        left.matchRank - right.matchRank ||
        left.relationRank - right.relationRank ||
        right.score - left.score ||
        right.thread.updatedAt - left.thread.updatedAt ||
        compareCodepoint(left.thread.id, right.thread.id),
    )
    .slice(0, SOURCE_LIMIT)
    .map((ranked) => ranked.suggestion);
}

function namedMentionSuggestions<Kind extends "project" | "section">(
  kind: Kind,
  candidates: readonly { id: string; name: string }[],
  query: string,
) {
  return fuzzyMatchText({
    items: candidates,
    query,
    getText: (candidate) => candidate.name.trim() || candidate.id,
    getAliases: (candidate) => [candidate.id],
    limit: candidates.length,
  })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.item.name.localeCompare(right.item.name) ||
        compareCodepoint(left.item.id, right.item.id),
    )
    .slice(0, SOURCE_LIMIT)
    .map(({ item }) => ({
      kind,
      path: `${kind}:${item.id}`,
      replacement: `${kind}:${item.id}`,
      [`${kind}Id`]: item.id,
      name: item.name.trim() || item.id,
    })) as Extract<PromptMentionSuggestion, { kind: Kind }>[];
}

export function usePromptMentions(
  projectId: string | undefined,
  options: {
    currentThreadId?: string;
    environmentId: string | null;
    hostId?: string | null;
  },
) {
  const [active, setActive] = useState<{
    query: string;
    trigger: PluginMentionTrigger;
  } | null>(null);
  const setQuery = useCallback(
    (query: string | null, trigger: PluginMentionTrigger | null) =>
      setActive(
        query === null
          ? null
          : { query, trigger: trigger ?? DEFAULT_PLUGIN_MENTION_TRIGGER },
      ),
    [],
  );
  const trigger = active?.trigger ?? DEFAULT_PLUGIN_MENTION_TRIGGER;
  const builtIn = trigger === DEFAULT_PLUGIN_MENTION_TRIGGER;
  const query = active?.query.trim() ?? "";
  const hasQuery = query.length > 0;

  const pathSearch = usePathSuggestions({
    projectId,
    query: builtIn ? (active?.query ?? null) : null,
    limit: SOURCE_LIMIT,
    environmentId: options.environmentId,
    hostId: options.hostId,
    includeDirectories: true,
  });
  const navigation = useSidebarNavigation({ enabled: builtIn && hasQuery });
  const threadsQuery = useThreadMentionCandidates({
    enabled: builtIn && hasQuery,
  });
  const providers = usePluginContributions().data?.mentionProviders;
  const hasProviders =
    providers?.some((provider) => provider.triggers.includes(trigger)) ?? false;
  const triggers = useMemo(
    () =>
      PLUGIN_MENTION_TRIGGER_VALUES.filter(
        (candidate) =>
          candidate === DEFAULT_PLUGIN_MENTION_TRIGGER ||
          providers?.some((provider) => provider.triggers.includes(candidate)),
      ),
    [providers],
  );
  const debouncedQuery = useDebouncedValue(query, PATH_SUGGESTION_DEBOUNCE_MS);
  const pluginSearchIsCurrent = debouncedQuery === query;
  const pluginSearch = usePluginMentionSearch(
    {
      trigger,
      query: debouncedQuery,
      projectId: projectId ?? null,
      threadId: options.currentThreadId ?? null,
    },
    {
      enabled:
        hasProviders && pluginSearchIsCurrent && debouncedQuery.length > 0,
    },
  );
  const resolveTitle = useResolveThreadTitle();
  const { currentThreadId, environmentId } = options;
  const paths = pathSearch.suggestions;
  const threads = threadsQuery.data ?? NO_THREADS;
  const sidebar = navigation.data;
  const pluginGroups =
    hasProviders && pluginSearchIsCurrent ? pluginSearch.data : undefined;
  const results = useMemo(() => {
    if (!hasQuery) return orderMentionSuggestions([], "");
    const projects = sidebar
      ? [...sidebar.projects, sidebar.personalProject]
      : [];
    const builtInSources: PromptMentionSuggestion[][] = builtIn
      ? [
          threadMentionSuggestions({
            threads,
            query,
            currentProjectId: projectId,
            currentThreadId,
            currentEnvironmentId: environmentId,
            projectNamesById: new Map(
              sidebar?.projects.map((project) => [project.id, project.name]),
            ),
            resolveTitle,
          }),
          namedMentionSuggestions("project", projects, query),
          namedMentionSuggestions("section", sidebar?.sections ?? [], query),
        ]
      : [];
    const pathSuggestions = paths.map(
      ({ source, entryKind, path, name }): PromptMentionSuggestion => ({
        kind: "path",
        source,
        entryKind,
        path,
        name,
        replacement:
          entryKind === "directory" && !path.endsWith("/") ? `${path}/` : path,
      }),
    );
    const pluginSuggestions = (pluginGroups ?? []).flatMap((group) =>
      group.items.flatMap((item): PromptMentionSuggestion[] => {
        const title = item.title.trim();
        return title.length === 0
          ? []
          : [
              {
                kind: "plugin",
                pluginId: group.pluginId,
                providerId: group.providerId,
                itemId: item.itemId,
                providerLabel: group.label,
                title,
                subtitle: item.subtitle,
                icon: item.icon,
                replacement: title,
              },
            ];
      }),
    );
    return orderMentionSuggestions(
      query.includes("/")
        ? [pathSuggestions, ...builtInSources, pluginSuggestions].flat()
        : [...builtInSources, pathSuggestions, pluginSuggestions].flat(),
      query,
    );
  }, [
    builtIn,
    currentThreadId,
    environmentId,
    hasQuery,
    paths,
    pluginGroups,
    projectId,
    query,
    resolveTitle,
    sidebar,
    threads,
  ]);

  const threadsLoading = threadsQuery.isLoading || threadsQuery.isFetching;
  return {
    triggers,
    setQuery,
    results,
    isLoading:
      hasQuery &&
      results.suggestions.length === 0 &&
      ((builtIn &&
        (pathSearch.isDebouncing || pathSearch.isLoading || threadsLoading)) ||
        (hasProviders &&
          (!pluginSearchIsCurrent ||
            pluginSearch.isLoading ||
            pluginSearch.isFetching))),
    isError:
      (builtIn && pathSearch.isError) ||
      (builtIn && hasQuery && threadsQuery.isError && !threadsLoading),
  };
}
