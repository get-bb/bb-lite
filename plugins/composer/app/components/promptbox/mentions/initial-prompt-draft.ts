import type { ResolveThreadMentionsResponse } from "@bb/server-contract";
import { callOp, threads } from "@bb/plugin/app";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { isRawThreadId } from "@bb/domain";
import type { PromptDraftState } from "@bb/client-core";
import { THREAD_MENTION_RESOLVE_MAX_IDS } from "@bb/server-contract";
import {
  resolveSerializedPromptMentions,
  useSidebarThreadTitleMentionResources,
} from "@bb/app-kit/components/thread/ThreadTitleMentions";
import { useSidebarNavigation } from "@bb/app-kit/hooks/queries/sidebar-navigation-query";

export async function resolveInitialPromptDraft(
  draft: PromptDraftState,
  resolveMentions: (
    threadIds: string[],
    signal: AbortSignal,
  ) => Promise<ResolveThreadMentionsResponse>,
  signal: AbortSignal,
): Promise<PromptDraftState> {
  const threadIds = [
    ...new Set(
      draft.mentions.flatMap(({ resource }) =>
        resource.kind === "thread" &&
        resource.projectId === undefined &&
        isRawThreadId(resource.threadId)
          ? [resource.threadId]
          : [],
      ),
    ),
  ];
  const resolvedById = new Map<string, { projectId: string; label: string }>();
  const unavailableIds = new Set<string>();
  for (
    let offset = 0;
    offset < threadIds.length;
    offset += THREAD_MENTION_RESOLVE_MAX_IDS
  ) {
    const batch = threadIds.slice(
      offset,
      offset + THREAD_MENTION_RESOLVE_MAX_IDS,
    );
    try {
      const resolutions = await resolveMentions(batch, signal);
      for (const resolution of resolutions)
        resolvedById.set(resolution.threadId, resolution);
      for (const id of batch) if (!resolvedById.has(id)) unavailableIds.add(id);
    } catch {
      if (signal.aborted) return draft;
    }
  }
  return {
    ...draft,
    mentions: draft.mentions.map((mention) => {
      const { resource } = mention;
      if (resource.kind !== "thread") return mention;
      const resolved = resolvedById.get(resource.threadId);
      if (resolved !== undefined) {
        return {
          ...mention,
          resource: {
            ...resource,
            projectId: resolved.projectId,
            label: resolved.label,
          },
        };
      }
      return unavailableIds.has(resource.threadId)
        ? { ...mention, resource: { ...resource, label: "Unavailable thread" } }
        : mention;
    }),
  };
}

export function useInitialPromptDraft(
  text: string | null,
): PromptDraftState | undefined {
  const navigation = useSidebarNavigation({ enabled: text !== null });
  const resources = useSidebarThreadTitleMentionResources(navigation.data);
  const draft = useMemo<PromptDraftState>(
    () => ({
      text: text ?? "",
      mentions: resolveSerializedPromptMentions(text ?? "", resources),
      attachments: [],
    }),
    [resources, text],
  );
  return useQuery({
    queryKey: ["initial-prompt-draft", draft],
    queryFn: ({ signal }) =>
      resolveInitialPromptDraft(
        draft,
        (threadIds, aborted) =>
          callOp(threads.resolveMentions, { threadIds }, { signal: aborted }),
        signal,
      ),
    enabled: text !== null && !navigation.isPending,
    staleTime: Infinity,
  }).data;
}
