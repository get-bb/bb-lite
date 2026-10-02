import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentPropsWithoutRef,
  type ReactNode,
  type Ref,
} from "react";
import {
  isRawThreadId,
  RAW_THREAD_ID_PATTERN_SOURCE,
  type PromptMentionResource,
  type PromptTextMention,
  type ThreadListEntry,
} from "@bb/domain";
import { QueryClientContext, type QueryClient } from "@tanstack/react-query";
import {
  THREAD_MENTION_RESOLVE_MAX_IDS,
  type ThreadResponse,
} from "@bb/server-contract";
import { PromptMentionPill } from "@/components/thread/timeline/ConversationMessageMentions";
import { useThread } from "@/hooks/queries/thread-queries";
import { threadQueryKey } from "@/hooks/queries/query-keys";
import { sdk } from "@/lib/sdk";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { cn } from "@bb/shared-ui/lib/utils";

type TitleThread = Pick<
  ThreadListEntry,
  "id" | "projectId" | "title" | "titleFallback"
>;
type NamedThreads = {
  id: string;
  name: string;
  threads: readonly TitleThread[];
};

export interface ThreadTitleMentionResources {
  sectionNamesById: ReadonlyMap<string, string>;
  projectNamesById: ReadonlyMap<string, string>;
  threadById: ReadonlyMap<string, TitleThread>;
}

export interface ThreadTitleMentionNavigationSource {
  sections: readonly { id: string; name: string }[];
  projects: readonly NamedThreads[];
  personalProject: NamedThreads;
}

export const EMPTY_TITLE_MENTION_RESOURCES: ThreadTitleMentionResources = {
  sectionNamesById: new Map(),
  projectNamesById: new Map(),
  threadById: new Map(),
};

const ResourcesContext = createContext(EMPTY_TITLE_MENTION_RESOURCES);

export const ThreadTitleMentionResourcesProvider = ResourcesContext.Provider;

export function useThreadTitleMentionResources(): ThreadTitleMentionResources {
  return useContext(ResourcesContext);
}

function sameMap<Value>(
  left: ReadonlyMap<string, Value>,
  right: ReadonlyMap<string, Value>,
  same: (left: Value, right: Value) => boolean,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    const other = right.get(key);
    if (other === undefined || !same(value, other)) return false;
  }
  return true;
}

export function useSidebarThreadTitleMentionResources(
  navigation: ThreadTitleMentionNavigationSource | undefined,
): ThreadTitleMentionResources {
  const [retained, setRetained] = useState(EMPTY_TITLE_MENTION_RESOURCES);
  const built = useMemo(() => {
    if (navigation === undefined) return EMPTY_TITLE_MENTION_RESOURCES;
    const projects = [...navigation.projects, navigation.personalProject];
    return {
      sectionNamesById: new Map(
        navigation.sections.map((section) => [section.id, section.name]),
      ),
      projectNamesById: new Map(
        projects.map((project) => [project.id, project.name]),
      ),
      threadById: new Map(
        projects.flatMap((project) =>
          project.threads.map((thread) => [thread.id, thread] as const),
        ),
      ),
    };
  }, [navigation]);
  const unchanged = useMemo(
    () =>
      retained === built ||
      (sameMap(retained.sectionNamesById, built.sectionNamesById, Object.is) &&
        sameMap(retained.projectNamesById, built.projectNamesById, Object.is) &&
        sameMap(
          retained.threadById,
          built.threadById,
          (left, right) =>
            left.projectId === right.projectId &&
            left.title === right.title &&
            left.titleFallback === right.titleFallback,
        )),
    [built, retained],
  );
  if (!unchanged) setRetained(built);
  return unchanged ? retained : built;
}

type ResolvedMentions = ReadonlyMap<string, PromptMentionResource | null>;
let resolvedMentions: ResolvedMentions = new Map();
const requestedMentionIds = new Set<string>();
const pendingMentionIds = new Set<string>();
const mentionListeners = new Set<() => void>();
let mentionFlushTimer: ReturnType<typeof setTimeout> | null = null;

function flushMentionRequests(): void {
  const threadIds = [...pendingMentionIds].slice(
    0,
    THREAD_MENTION_RESOLVE_MAX_IDS,
  );
  for (const threadId of threadIds) pendingMentionIds.delete(threadId);
  mentionFlushTimer =
    pendingMentionIds.size > 0 ? setTimeout(flushMentionRequests, 25) : null;
  if (threadIds.length === 0) return;
  void sdk.threads.resolveMentions({ threadIds }).then(
    (resolutions) => {
      const next = new Map(resolvedMentions);
      for (const threadId of threadIds) next.set(threadId, null);
      for (const { threadId, projectId, label } of resolutions) {
        next.set(threadId, { kind: "thread", threadId, projectId, label });
      }
      resolvedMentions = next;
      for (const listener of mentionListeners) listener();
    },
    () => {},
  );
}

function requestMentionResolution(threadId: string): void {
  if (requestedMentionIds.has(threadId)) return;
  requestedMentionIds.add(threadId);
  pendingMentionIds.add(threadId);
  if (mentionFlushTimer !== null) clearTimeout(mentionFlushTimer);
  mentionFlushTimer = setTimeout(flushMentionRequests, 25);
}

function subscribeResolvedMentions(listener: () => void): () => void {
  mentionListeners.add(listener);
  return () => mentionListeners.delete(listener);
}

function threadResource(
  threadId: string,
  thread: TitleThread | undefined,
): PromptMentionResource | null {
  return thread === undefined
    ? null
    : {
        kind: "thread",
        threadId,
        projectId: thread.projectId,
        label: getThreadDisplayTitle(thread),
      };
}

function knownThreadResource(
  threadId: string,
  resources: ThreadTitleMentionResources,
  queryClient: QueryClient | undefined,
): PromptMentionResource | null {
  return threadResource(
    threadId,
    resources.threadById.get(threadId) ??
      queryClient?.getQueryData<ThreadResponse>(threadQueryKey(threadId)),
  );
}

export function RawThreadMentionBatchProvider({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}

export function useRawThreadMentionResources(
  threadIds: readonly string[],
): ReadonlyMap<string, PromptMentionResource> {
  const resources = useContext(ResourcesContext);
  const queryClient = useContext(QueryClientContext);
  const resolved = useSyncExternalStore(
    subscribeResolvedMentions,
    () => resolvedMentions,
  );
  useEffect(() => {
    for (const threadId of threadIds) {
      if (knownThreadResource(threadId, resources, queryClient) === null) {
        requestMentionResolution(threadId);
      }
    }
  }, [queryClient, resources, threadIds]);
  return new Map(
    threadIds.flatMap((threadId) => {
      const resource =
        knownThreadResource(threadId, resources, queryClient) ??
        resolved.get(threadId);
      return resource ? [[threadId, resource] as const] : [];
    }),
  );
}

export function useRawThreadMentionResource(
  threadId: string,
): PromptMentionResource | null {
  const threadIds = useMemo(() => [threadId], [threadId]);
  return useRawThreadMentionResources(threadIds).get(threadId) ?? null;
}

export function useSidebarThreadMentionResource(
  threadId: string,
): PromptMentionResource | null {
  const { threadById } = useContext(ResourcesContext);
  return threadResource(threadId, threadById.get(threadId));
}

export function useThreadMentionResource(
  threadId: string,
): PromptMentionResource | null {
  const sidebarResource = useSidebarThreadMentionResource(threadId);
  const { data } = useThread(threadId, { enabled: sidebarResource === null });
  return sidebarResource ?? threadResource(threadId, data);
}

const TITLE_MENTION_PATTERN = new RegExp(
  `@(?:thread:[A-Za-z0-9_-]+|project:[A-Za-z0-9_-]+|(?:section|folder):[A-Za-z0-9_-]+|(?:thread-storage:)?(?:(?:[\\p{L}\\p{N}._-]+\\/)+(?:[\\p{L}\\p{N}._-]*\\.[\\p{L}\\p{N}_-]+)?|[\\p{L}\\p{N}._-]*\\.[\\p{L}\\p{N}_-]+))|${RAW_THREAD_ID_PATTERN_SOURCE}`,
  "gu",
);
const UNRESOLVED_THREAD_LABEL = "Thread";

export function isMentionBoundary(text: string, index: number): boolean {
  const previous = text[index - 1];
  return previous === undefined || !/[\p{L}\p{N}_.+-]/u.test(previous);
}

export function isRawThreadIdBoundary(text: string, index: number): boolean {
  const previous = text[index - 1];
  return (
    previous !== "/" && previous !== "\\" && isMentionBoundary(text, index)
  );
}

export function isMentionEndBoundary(text: string, index: number): boolean {
  const next = text[index];
  if (next === undefined) return true;
  if (next === ".") {
    const afterPeriod = text[index + 1];
    return afterPeriod === undefined || /[\s,;:!?)}\]"'’”]/u.test(afterPeriod);
  }
  return !/[\p{L}\p{N}_.+\/-]/u.test(next);
}

export function isRawThreadIdEndBoundary(text: string, index: number): boolean {
  return text[index] !== "\\" && isMentionEndBoundary(text, index);
}

function hasUnsupportedPathContinuation(text: string, index: number): boolean {
  return /^\s+(?:[\p{L}\p{N}._-]+(?:\s+|\/))*[\p{L}\p{N}_-]+(?:\/|\.[\p{L}\p{N}_-]+)(?=$|[\s,;:!?)}\]])/u.test(
    text.slice(index),
  );
}

function resolveTitleMentionResource(
  token: string,
  resources: ThreadTitleMentionResources,
): PromptMentionResource | null {
  const match = /^@(thread|project|section|folder):(.*)$/u.exec(token);
  const kind = match?.[1];
  const id = match?.[2] ?? "";
  if (kind === "thread") {
    const resource = threadResource(id, resources.threadById.get(id));
    return resource !== null || isRawThreadId(id)
      ? resource
      : { kind: "thread", threadId: id, label: id };
  }
  if (kind === "project") {
    return {
      kind: "project",
      projectId: id,
      label: resources.projectNamesById.get(id) ?? id,
    };
  }
  if (kind !== undefined) {
    return {
      kind: "section",
      sectionId: id,
      label: resources.sectionNamesById.get(id) ?? id,
    };
  }
  const serializedPath = token.slice(1);
  const source = serializedPath.startsWith("thread-storage:")
    ? "thread-storage"
    : "workspace";
  const path =
    source === "thread-storage"
      ? serializedPath.slice("thread-storage:".length)
      : serializedPath;
  const isDirectory = path.endsWith("/");
  const normalizedPath = isDirectory ? path.slice(0, -1) : path;
  return {
    kind: "path",
    source,
    entryKind: isDirectory ? "directory" : "file",
    path: normalizedPath,
    label:
      normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1) ||
      normalizedPath,
  };
}

interface TitleSegment {
  unresolvedThreadId: string | null;
  resource: PromptMentionResource | null;
  serializedText: string | null;
  text: string;
}

function plainSegment(text: string): TitleSegment {
  return {
    unresolvedThreadId: null,
    resource: null,
    serializedText: null,
    text,
  };
}

function titleSegments(
  title: string,
  resources: ThreadTitleMentionResources,
): TitleSegment[] {
  const segments: TitleSegment[] = [];
  let cursor = 0;
  for (const match of title.matchAll(TITLE_MENTION_PATTERN)) {
    const token = match[0];
    const end = match.index + token.length;
    const isRaw: boolean = isRawThreadId(token);
    const isPath =
      !isRaw && !/^@(?:thread|project|section|folder):/u.test(token);
    if (
      !(isRaw ? isRawThreadIdBoundary : isMentionBoundary)(
        title,
        match.index,
      ) ||
      !(isRaw ? isRawThreadIdEndBoundary : isMentionEndBoundary)(title, end) ||
      (isPath && hasUnsupportedPathContinuation(title, end))
    ) {
      continue;
    }
    if (match.index > cursor) {
      segments.push(plainSegment(title.slice(cursor, match.index)));
    }
    const serializedThreadId =
      !isRaw && token.startsWith("@thread:")
        ? token.slice("@thread:".length)
        : null;
    const resource = isRaw
      ? threadResource(token, resources.threadById.get(token))
      : resolveTitleMentionResource(token, resources);
    const unresolvedThreadId =
      resource !== null ? null : isRaw ? token : serializedThreadId;
    segments.push({
      unresolvedThreadId,
      resource,
      serializedText:
        resource === null && unresolvedThreadId === null ? null : token,
      text:
        resource?.label ??
        (serializedThreadId === null ? token : UNRESOLVED_THREAD_LABEL),
    });
    cursor = end;
  }
  if (segments.length === 0) return [plainSegment(title)];
  if (cursor < title.length) segments.push(plainSegment(title.slice(cursor)));
  return segments;
}

export function resolveSerializedPromptMentions(
  text: string,
  resources: ThreadTitleMentionResources,
): PromptTextMention[] {
  const mentions: PromptTextMention[] = [];
  let cursor = 0;
  for (const segment of titleSegments(text, resources)) {
    const token = segment.serializedText ?? segment.text;
    const end = cursor + token.length;
    const resource =
      segment.resource ??
      (segment.unresolvedThreadId === null
        ? null
        : ({
            kind: "thread",
            threadId: segment.unresolvedThreadId,
            label: UNRESOLVED_THREAD_LABEL,
          } as const));
    if (resource !== null && /^@(?:thread|project|section):/u.test(token)) {
      mentions.push({ start: cursor, end, resource });
    }
    cursor = end;
  }
  return mentions;
}

export function resolveThreadTitleDisplayText(
  title: string,
  resources: ThreadTitleMentionResources,
): string {
  return titleSegments(title, resources)
    .map((segment) => segment.text)
    .join("");
}

export function useResolveThreadTitle(): (title: string) => string {
  const resources = useContext(ResourcesContext);
  return (title) => resolveThreadTitleDisplayText(title, resources);
}

interface ResolvedTitleSegment extends TitleSegment {
  offset: number;
  isUnavailable: boolean;
}

function useResolvedTitleSegments(title: string): ResolvedTitleSegment[] {
  const resources = useContext(ResourcesContext);
  const segments = useMemo(
    () => titleSegments(title, resources),
    [resources, title],
  );
  const unresolvedThreadIds = useMemo(
    () => [
      ...new Set(
        segments.flatMap((segment) => segment.unresolvedThreadId ?? []),
      ),
    ],
    [segments],
  );
  const resolvedById = useRawThreadMentionResources(unresolvedThreadIds);
  const resolved = useSyncExternalStore(
    subscribeResolvedMentions,
    () => resolvedMentions,
  );
  const result: ResolvedTitleSegment[] = [];
  let offset = 0;
  for (const segment of segments) {
    const threadId = segment.unresolvedThreadId;
    const resource =
      threadId === null ? segment.resource : resolvedById.get(threadId);
    result.push({
      ...segment,
      resource: resource ?? null,
      text: resource?.label ?? segment.text,
      offset,
      isUnavailable: threadId !== null && resolved.get(threadId) === null,
    });
    offset += (segment.serializedText ?? segment.text).length;
  }
  return result;
}

export function useThreadTitleDisplayText(title: string): string {
  return useResolvedTitleSegments(title)
    .map((segment) =>
      segment.resource === null &&
      segment.isUnavailable &&
      segment.serializedText?.startsWith("@thread:")
        ? "Unavailable thread"
        : segment.text,
    )
    .join("");
}

interface TitleHighlightRange {
  start: number;
  end: number;
}

function highlightedText(
  text: string,
  offset: number,
  ranges: readonly TitleHighlightRange[],
): ReactNode {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const range of ranges) {
    const start = Math.max(cursor, Math.min(range.start - offset, text.length));
    const end = Math.max(start, Math.min(range.end - offset, text.length));
    if (end <= start) continue;
    if (start > cursor) nodes.push(text.slice(cursor, start));
    nodes.push(
      <mark
        key={`${start}:${end}`}
        className="rounded-sm bg-[var(--sidebar-search-match)] px-0.5 py-px text-foreground"
      >
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  }
  if (nodes.length === 0) return text;
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

interface ThreadTitleMentionsProps {
  title: string;
  highlightRanges?: readonly TitleHighlightRange[];
}

export function ThreadTitleMentions({
  title,
  highlightRanges = [],
}: ThreadTitleMentionsProps) {
  return useResolvedTitleSegments(title).map((segment, index) => {
    const { serializedText, unresolvedThreadId: threadId } = segment;
    if (serializedText === null) {
      return (
        <span key={`${index}:text`} className="truncate whitespace-pre">
          {highlightedText(segment.text, segment.offset, highlightRanges)}
        </span>
      );
    }
    const isSerializedThread = serializedText.startsWith("@thread:");
    if (segment.resource === null && threadId !== null && !isSerializedThread) {
      return (
        <span key={`${index}:${threadId}`} className="truncate">
          {threadId}
        </span>
      );
    }
    return (
      <PromptMentionPill
        key={`${index}:${threadId ?? serializedText}`}
        interactive={false}
        resource={
          segment.resource ?? {
            kind: "thread",
            threadId: threadId ?? "",
            label: segment.isUnavailable
              ? "Unavailable thread"
              : UNRESOLVED_THREAD_LABEL,
          }
        }
        serializedText={serializedText}
      />
    );
  });
}

interface ThreadTitleProps
  extends
    Omit<ComponentPropsWithoutRef<"span">, "children" | "title">,
    ThreadTitleMentionsProps {
  inline?: boolean;
  tooltip?: boolean;
  ref?: Ref<HTMLSpanElement>;
}

export function ThreadTitle({
  title,
  inline = false,
  tooltip = false,
  highlightRanges,
  className,
  ...spanProps
}: ThreadTitleProps) {
  const displayTitle = useThreadTitleDisplayText(title);
  return (
    <span
      {...spanProps}
      className={cn(!inline && "bb-thread-title", className)}
      title={tooltip ? displayTitle : undefined}
    >
      <ThreadTitleMentions title={title} highlightRanges={highlightRanges} />
    </span>
  );
}
