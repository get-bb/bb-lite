import { useQuery } from "@tanstack/react-query";
import {
  pluginMentionGroupSchema,
  type PluginMentionGroup,
  type PluginMentionTrigger,
} from "@bb/server-contract";
import { z } from "zod";
import { sdk } from "@/lib/sdk";
import { qk } from "./query-keys";

export type PluginMentionSearchGroup = PluginMentionGroup;

interface PluginMentionSearchArgs {
  trigger: PluginMentionTrigger;
  query: string;
  projectId: string | null;
  threadId: string | null;
}

const mentionSearchSchema = z.object({
  groups: z.array(pluginMentionGroupSchema),
});

export function usePluginContributions() {
  return useQuery({
    queryKey: qk.pluginContributions(),
    queryFn: ({ signal }) => sdk.plugins.contributions({ signal }),
    staleTime: 30_000,
  });
}

async function searchPluginMentions(
  args: PluginMentionSearchArgs,
  signal: AbortSignal,
): Promise<PluginMentionSearchGroup[]> {
  const params = new URLSearchParams({ q: args.query, trigger: args.trigger });
  if (args.projectId !== null) params.set("projectId", args.projectId);
  if (args.threadId !== null) params.set("threadId", args.threadId);
  const path = `/api/v1/plugins/mentions/search?${params.toString()}`;
  const response = await fetch(path, { signal });
  if (!response.ok) return [];
  return mentionSearchSchema.parse(await response.json()).groups;
}

export function usePluginMentionSearch(
  args: PluginMentionSearchArgs,
  options: { enabled: boolean },
) {
  return useQuery({
    queryKey: qk.pluginMentionSearch(args),
    queryFn: ({ signal }) => searchPluginMentions(args, signal),
    enabled: options.enabled,
    staleTime: 15_000,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[2] === args.trigger ? previous : undefined,
  });
}
