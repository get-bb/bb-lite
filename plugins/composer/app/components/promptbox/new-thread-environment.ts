import {
  findLocalPathProjectSourceForHost,
  type ProjectSource,
  type ThreadListEntry,
} from "@bb/domain";
import type { SystemEnvironmentProvider } from "@bb/server-contract";
import { defaultEnvironmentProvider } from "@bb/client-core";
import {
  encodeProviderValue,
  parseEnvironmentValue,
} from "@bb/app-kit/components/pickers/environment-picker-value";
import type { ReuseThreadOption } from "../pickers/ReuseEnvironmentPicker";
import { getThreadDisplayTitle } from "@bb/app-kit/lib/thread-title";

export function buildReuseThreadOptions(
  threads: readonly ThreadListEntry[],
  hostNameById: ReadonlyMap<string, string> | null,
): ReuseThreadOption[] {
  const byEnvironmentId = new Map<
    string,
    { first: ThreadListEntry; threads: ThreadListEntry[] }
  >();
  for (const thread of threads) {
    if (thread.environmentId === null) continue;
    const group = byEnvironmentId.get(thread.environmentId);
    if (group) group.threads.push(thread);
    else {
      byEnvironmentId.set(thread.environmentId, {
        first: thread,
        threads: [thread],
      });
    }
  }
  return [...byEnvironmentId]
    .map(([environmentId, { first, threads: group }]) => ({
      environmentId,
      branchName: first.environmentBranchName,
      name: first.environmentName,
      path: first.environmentPath,
      environmentProviderId: first.environmentProviderId,
      hostName:
        (first.environmentHostId !== null
          ? hostNameById?.get(first.environmentHostId)
          : undefined) ?? null,
      threads: group
        .sort((left, right) => right.latestAttentionAt - left.latestAttentionAt)
        .map((thread) => ({
          id: thread.id,
          title: getThreadDisplayTitle(thread),
        })),
    }))
    .sort((left, right) => {
      const leftLabel = left.name ?? left.branchName;
      const rightLabel = right.name ?? right.branchName;
      return leftLabel && rightLabel
        ? leftLabel.localeCompare(rightLabel)
        : left.environmentId.localeCompare(right.environmentId);
    });
}

export function resolveEffectiveEnvironmentValue({
  value,
  providers,
  isProjectless,
  knownHostIds,
  primaryHostId,
  projectSources,
  reuseThreadOptions,
  reuseThreadOptionsLoading,
}: {
  value: string;
  providers: readonly SystemEnvironmentProvider[] | undefined;
  isProjectless: boolean;
  knownHostIds: ReadonlySet<string>;
  primaryHostId: string | null;
  projectSources: readonly ProjectSource[];
  reuseThreadOptions: readonly ReuseThreadOption[];
  reuseThreadOptionsLoading: boolean;
}): string {
  const parsed = parseEnvironmentValue(value);
  const reuseSurvives =
    parsed?.type === "reuse" &&
    parsed.environmentId !== null &&
    (reuseThreadOptionsLoading ||
      reuseThreadOptions.some(
        (option) => option.environmentId === parsed.environmentId,
      ));
  if (isProjectless && reuseSurvives) return value;
  if (providers === undefined) return "";
  const selected =
    parsed?.type === "provider"
      ? providers.find(
          (provider) => provider.id === parsed.environmentProviderId,
        )
      : undefined;
  const fallbackId = defaultEnvironmentProvider(
    providers,
    isProjectless ? { projectless: true } : { workspace: "unmanaged" },
  )?.id;
  const fallback =
    primaryHostId !== null &&
    fallbackId !== undefined &&
    (isProjectless ||
      (knownHostIds.has(primaryHostId) &&
        findLocalPathProjectSourceForHost(projectSources, primaryHostId) !==
          undefined))
      ? encodeProviderValue(fallbackId)
      : "";
  if (!isProjectless && parsed?.type === "reuse") {
    return parsed.environmentId === null || reuseSurvives ? value : fallback;
  }
  return selected !== undefined && primaryHostId !== null ? value : fallback;
}
