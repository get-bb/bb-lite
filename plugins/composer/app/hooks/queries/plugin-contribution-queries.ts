import { callOp, plugins, sessions } from "@bb/plugin/app";
import { useQuery } from "@tanstack/react-query";
import type {
  PluginMentionGroup,
  PluginMentionTrigger,
} from "@bb/server-contract";
import { qk } from "@bb/app-kit/hooks/queries/query-keys";

export type PluginMentionSearchGroup = PluginMentionGroup;

interface PluginMentionSearchArgs {
  trigger: PluginMentionTrigger;
  query: string;
  projectId: string | null;
  threadId: string | null;
}

export function usePluginContributions() {
  return useQuery({
    queryKey: qk.pluginContributions(),
    queryFn: ({ signal }) => callOp(plugins.contributions, {}, { signal }),
    staleTime: 30_000,
  });
}

function searchPluginMentions(
  args: PluginMentionSearchArgs,
  signal: AbortSignal,
): Promise<PluginMentionSearchGroup[]> {
  return callOp(sessions.searchMentions, args, { signal }).catch(() => []);
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
