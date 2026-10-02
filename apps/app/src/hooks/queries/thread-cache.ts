import type {
  InfiniteData,
  QueryClient,
  QueryFilters,
  QueryKey,
} from "@tanstack/react-query";
import type { ThreadListEntry, ThreadWithRuntime } from "@bb/domain";
import type {
  SidebarBootstrapResponse,
  ThreadResponse,
} from "@bb/server-contract";
import { qk } from "./query-keys";

type ThreadListData = ThreadListEntry[] | InfiniteData<ThreadListEntry[]>;
type ThreadListMapper = (
  threads: ThreadListEntry[],
  projectId: string | null,
) => ThreadListEntry[];
export type ThreadPatch = Partial<ThreadListEntry>;
export type CacheSnapshot = [QueryKey, unknown][];

export function listSidebarNavigationThreads(
  navigation: SidebarBootstrapResponse,
): ThreadListEntry[] {
  return [
    ...navigation.projects.flatMap((project) => project.threads),
    ...navigation.personalProject.threads,
  ];
}

export function cachedThreads(client: QueryClient): ThreadListEntry[] {
  const navigation = client.getQueryData<SidebarBootstrapResponse>(
    qk.sidebar(),
  );
  const lists = client.getQueriesData<ThreadListData>({
    queryKey: qk.threadLists(),
  });
  return [
    ...(navigation ? listSidebarNavigationThreads(navigation) : []),
    ...lists.flatMap(([, data]) =>
      Array.isArray(data) ? data : (data?.pages.flat() ?? []),
    ),
  ];
}

export function findCachedThread(
  client: QueryClient,
  threadId: string,
): ThreadWithRuntime | undefined {
  return (
    client.getQueryData<ThreadResponse>(qk.threadDetail(threadId)) ??
    cachedThreads(client).find((thread) => thread.id === threadId)
  );
}

export function mapCachedThreadLists(
  client: QueryClient,
  mapper: ThreadListMapper,
): void {
  client.setQueryData<SidebarBootstrapResponse>(
    qk.sidebar(),
    (navigation) =>
      navigation && {
        sections: navigation.sections,
        projects: navigation.projects.map((project) => ({
          ...project,
          threads: mapper(project.threads, project.id),
        })),
        personalProject: {
          ...navigation.personalProject,
          threads: mapper(
            navigation.personalProject.threads,
            navigation.personalProject.id,
          ),
        },
      },
  );
  client.setQueriesData<ThreadListData>(
    { queryKey: qk.threadLists() },
    (data) => {
      if (Array.isArray(data)) return mapper(data, null);
      const pages = data?.pages.map((page) => mapper(page, null));
      return data && pages ? { ...data, pages } : data;
    },
  );
}

export function patchCachedThreads(
  client: QueryClient,
  patchFor: (thread: ThreadWithRuntime) => ThreadPatch | undefined,
  threadIds: readonly string[],
): void {
  for (const threadId of threadIds) {
    client.setQueryData<ThreadResponse>(
      qk.threadDetail(threadId),
      (thread) => thread && { ...thread, ...patchFor(thread) },
    );
  }
  mapCachedThreadLists(client, (threads) =>
    threads.map((thread) => {
      const patch = threadIds.includes(thread.id) ? patchFor(thread) : null;
      return patch ? { ...thread, ...patch } : thread;
    }),
  );
}

export async function snapshotThreadCaches(
  client: QueryClient,
  threadIds: readonly string[],
): Promise<CacheSnapshot> {
  const filters: QueryFilters[] = [
    { queryKey: qk.sidebar() },
    { queryKey: qk.threadLists() },
    ...threadIds.map((id) => ({ queryKey: qk.threadDetail(id), exact: true })),
  ];
  await Promise.all(filters.map((filter) => client.cancelQueries(filter)));
  return filters.flatMap((filter) => client.getQueriesData(filter));
}

export function restoreCacheSnapshot(
  client: QueryClient,
  snapshot: CacheSnapshot | undefined,
): void {
  for (const [queryKey, data] of snapshot ?? []) {
    client.setQueryData(queryKey, data);
  }
}

export function refreshThreadCaches(
  client: QueryClient,
  threadIds: readonly string[],
): void {
  void client.invalidateQueries({ queryKey: qk.sidebar() });
  void client.invalidateQueries({ queryKey: qk.threadLists() });
  void client.invalidateQueries({ queryKey: qk.threadSearch() });
  for (const threadId of threadIds) {
    void client.invalidateQueries({
      queryKey: qk.threadDetail(threadId),
      exact: true,
    });
  }
}
