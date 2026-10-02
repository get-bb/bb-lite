import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@bb/shared-ui/button";
import { ProjectSelector } from "@/components/pickers/ProjectSelector";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { EmptyStatePanel } from "@bb/shared-ui/empty-state";
import { Icon } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import { Pill } from "@bb/shared-ui/pill";
import { ThreadUnarchiveButton } from "@/components/thread/ThreadUnarchiveButton";
import { useUnarchiveThread } from "@/hooks/mutations/thread-state-mutations";
import {
  hasThreadSearchableQuery,
  useArchivedThreads,
  useThreadSearch,
  type UseArchivedThreadsFilters,
} from "@/hooks/queries/thread-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import type { ArchivedThreadsKindFilter } from "@/hooks/queries/query-keys";
import { getThreadRoutePath } from "@/lib/route-paths";
import { formatRelativeTime } from "@/lib/relative-time";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import {
  ThreadTitle,
  useResolveThreadTitle,
} from "@/components/thread/ThreadTitleMentions";

const ALL_PROJECTS = "all";
const ARCHIVED_THREAD_SEARCH_LIMIT = 50;

const KIND_OPTIONS: ReadonlyArray<{
  label: string;
  value: ArchivedThreadsKindFilter;
}> = [
  { label: "All threads", value: "all" },
  { label: "Root threads", value: "root" },
  { label: "Child threads", value: "child" },
];

function KindFilterMenu({
  onChange,
  value,
}: {
  onChange: (value: ArchivedThreadsKindFilter) => void;
  value: ArchivedThreadsKindFilter;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="h-8 min-w-36 justify-between gap-2 px-3 text-xs font-normal"
        >
          <span className="flex min-w-0 items-center gap-2">
            <Icon name="SlidersHorizontal" className="size-3.5 shrink-0" />
            <span className="truncate">
              {KIND_OPTIONS.find((option) => option.value === value)?.label}
            </span>
          </span>
          <Icon name="ChevronDown" className="size-3.5 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {KIND_OPTIONS.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onSelect={() => onChange(option.value)}
          >
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {option.value === value ? (
              <Icon name="Check" className="size-3.5" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ArchivedThreadsSettingsSection() {
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<ArchivedThreadsKindFilter>("all");
  const [projectId, setProjectId] = useState(ALL_PROJECTS);
  const sidebarNavigation = useSidebarNavigation();
  const searchIsActive = hasThreadSearchableQuery(search);
  const archivedThreadsQuery = useArchivedThreads(
    {
      ...(projectId === ALL_PROJECTS ? {} : { projectId }),
      kind,
    } satisfies UseArchivedThreadsFilters,
    { enabled: !searchIsActive },
  );
  const threadSearch = useThreadSearch({
    active: searchIsActive,
    limitPerGroup: ARCHIVED_THREAD_SEARCH_LIMIT,
    query: search,
  });
  const unarchiveThread = useUnarchiveThread();
  const resolveTitle = useResolveThreadTitle();

  const navigation = sidebarNavigation.data;
  const projects = navigation
    ? [navigation.personalProject, ...navigation.projects]
    : [];
  const needle = search.trim().toLocaleLowerCase();
  const archivedThreads = (
    searchIsActive
      ? (threadSearch.data?.archived.results.map((result) => result.thread) ??
        [])
      : (archivedThreadsQuery.data?.pages ?? []).flat()
  ).filter((thread) => {
    const title = getThreadDisplayTitle(thread);
    return (
      thread.archivedAt !== null &&
      (projectId === ALL_PROJECTS || thread.projectId === projectId) &&
      (kind === "all" ||
        (thread.parentThreadId !== null) === (kind === "child")) &&
      (searchIsActive ||
        [title, resolveTitle(title)].some((text) =>
          text.toLocaleLowerCase().includes(needle),
        ))
    );
  });
  const groups = new Map<string, typeof archivedThreads>();
  for (const thread of archivedThreads) {
    const group = groups.get(thread.projectId) ?? [];
    groups.set(thread.projectId, [...group, thread]);
  }
  const groupedThreads = [...groups];
  const isInitialLoading = searchIsActive
    ? threadSearch.isDebouncing ||
      (threadSearch.isLoading && threadSearch.data === undefined)
    : archivedThreadsQuery.isPending;

  return (
    <section className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">
          Archived threads
        </h2>
        <p className="mt-1 text-xs text-subtle-foreground">
          Find and restore archived threads from across your projects.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Icon
            name="Search"
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle-foreground"
          />
          <Input
            aria-label="Search archived threads"
            className="h-8 pl-8 text-xs"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search archived threads…"
            value={search}
          />
        </div>
        <KindFilterMenu onChange={setKind} value={kind} />
        <ProjectSelector
          projects={projects}
          value={projectId}
          onChange={(value) => setProjectId(value ?? ALL_PROJECTS)}
          allProjectsValue={ALL_PROJECTS}
          variant="outline"
          modal={false}
          className="min-w-36 justify-between gap-2 px-3 font-normal"
        />
      </div>

      {isInitialLoading ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Loading archived threads…
        </p>
      ) : archivedThreads.length === 0 ? (
        <EmptyStatePanel className="py-8">
          {search.trim().length > 0
            ? "No archived threads match your search."
            : "No archived threads match these filters."}
        </EmptyStatePanel>
      ) : (
        <div className="space-y-6">
          {groupedThreads.map(([groupProjectId, threads]) => (
            <section key={groupProjectId} className="space-y-2">
              <div className="flex items-center gap-2 px-0.5 text-xs font-medium text-muted-foreground">
                <Icon name="Folder" className="size-3.5" />
                <h3 className="min-w-0 flex-1 truncate">
                  {projects.find((project) => project.id === groupProjectId)
                    ?.name ?? "Unknown project"}
                </h3>
                <span>
                  {threads.length} {threads.length === 1 ? "thread" : "threads"}
                </span>
              </div>
              <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                {threads.map((thread) => (
                  <div
                    key={thread.id}
                    className="flex min-h-14 items-center gap-3 px-4 py-2.5"
                  >
                    <Link
                      className="min-w-0 flex-1"
                      to={getThreadRoutePath({
                        projectId: thread.projectId,
                        threadId: thread.id,
                      })}
                    >
                      <span className="flex min-w-0 items-center gap-2 text-sm">
                        <ThreadTitle title={getThreadDisplayTitle(thread)} />
                        {thread.parentThreadId !== null ? (
                          <Pill variant="outline" className="shrink-0">
                            child
                          </Pill>
                        ) : null}
                      </span>
                      {thread.archivedAt !== null ? (
                        <span className="mt-0.5 block text-xs text-subtle-foreground">
                          Archived{" "}
                          {formatRelativeTime({
                            timestamp: thread.archivedAt,
                            now: Date.now(),
                          })}
                        </span>
                      ) : null}
                    </Link>
                    <ThreadUnarchiveButton
                      variant="secondary"
                      isPending={
                        unarchiveThread.isPending &&
                        unarchiveThread.variables?.id === thread.id
                      }
                      onUnarchive={() =>
                        unarchiveThread.mutate({ id: thread.id })
                      }
                    />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {!searchIsActive && archivedThreadsQuery.hasNextPage ? (
        <Button
          type="button"
          variant="ghost"
          className="h-9 w-full text-sm font-normal text-muted-foreground"
          disabled={archivedThreadsQuery.isFetchingNextPage}
          onClick={() => archivedThreadsQuery.fetchNextPage()}
        >
          {archivedThreadsQuery.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      ) : null}
    </section>
  );
}
