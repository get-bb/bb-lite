import { useCallback, useState } from "react";
import {
  useQueryClient,
  type QueryObserverResult,
} from "@tanstack/react-query";
import type { ThreadTimelineResponse, TimelineRow } from "@bb/server-contract";
import {
  areTimelinePaginationCursorsEqual,
  buildLoadedTimelineState,
  mergeLoadedTimelineWithLatest,
  prependOlderTimelineRows,
  recoverLoadedTimelineAfterStaleCursor,
  resolveLoadedTimelineSurfaceKey,
  type LoadedTimelineState,
} from "@bb/client-core";
import { threadTimelineQueryKey } from "@bb/app-kit/hooks/queries/query-keys";
import { useThreadTimeline } from "@bb/app-kit/hooks/queries/thread-queries";
import { BbHttpError, sdk } from "@bb/app-kit/lib/sdk";

type TimelineQueryResultProp =
  keyof QueryObserverResult<ThreadTimelineResponse>;

const PROPS_WITH_ROWS: TimelineQueryResultProp[] = [
  "data",
  "error",
  "isLoading",
  "isLoadingError",
];
const PROPS_WITHOUT_ROWS: TimelineQueryResultProp[] = [
  ...PROPS_WITH_ROWS,
  "isFetching",
];

export interface UseThreadTimelineControllerResult {
  activeThinking: ThreadTimelineResponse["activeThinking"];
  activeWorkflows: ThreadTimelineResponse["activeWorkflows"];
  activeBackgroundCommands: ThreadTimelineResponse["activeBackgroundCommands"];
  contextBoundarySeq: ThreadTimelineResponse["contextBoundarySeq"];
  contextWindowUsage: ThreadTimelineResponse["contextWindowUsage"];
  goal: ThreadTimelineResponse["goal"];
  modelFallback: ThreadTimelineResponse["modelFallback"];
  hasOlderTimelineRows: boolean;
  isLoadingOlderTimelineRows: boolean;
  loadOlderTimelineRows: () => Promise<void>;
  pendingTodos: ThreadTimelineResponse["pendingTodos"];
  timelineError: Error | null;
  timelineLoading: boolean;
  timelineRows: TimelineRow[];
}

function emptyLoadedTimeline(surfaceKey: string): LoadedTimelineState {
  return buildLoadedTimelineState({
    latestWindowEndSequence: null,
    latestRows: [],
    olderCursor: null,
    surfaceKey,
  });
}

function reconcileLoadedTimeline(
  current: LoadedTimelineState,
  latestTimeline: ThreadTimelineResponse | undefined,
  surfaceKey: string,
): LoadedTimelineState {
  if (!latestTimeline) {
    return current.surfaceKey === surfaceKey
      ? current
      : emptyLoadedTimeline(surfaceKey);
  }
  return mergeLoadedTimelineWithLatest({ current, latestTimeline, surfaceKey });
}

export function useThreadTimelineController({
  enabled = true,
  surfaceKey: explicitSurfaceKey,
  threadId,
}: {
  enabled?: boolean;
  surfaceKey?: string;
  threadId: string;
}): UseThreadTimelineControllerResult {
  const queryClient = useQueryClient();
  const notifyOnChangeProps = useCallback((): TimelineQueryResultProp[] => {
    const cachedTimeline = queryClient.getQueryData<ThreadTimelineResponse>(
      threadTimelineQueryKey(threadId),
    );
    return cachedTimeline !== undefined && cachedTimeline.rows.length > 0
      ? PROPS_WITH_ROWS
      : PROPS_WITHOUT_ROWS;
  }, [queryClient, threadId]);
  const latestTimelineQuery = useThreadTimeline(threadId, {
    enabled,
    notifyOnChangeProps,
    refetchOnMount: true,
  });
  const latestTimeline = latestTimelineQuery.data;
  const surfaceKey = resolveLoadedTimelineSurfaceKey(
    explicitSurfaceKey ?? threadId,
    latestTimeline,
  );
  const [loadedTimelineTracker, setLoadedTimelineTracker] = useState(() => ({
    latestTimeline,
    loaded: reconcileLoadedTimeline(
      emptyLoadedTimeline(surfaceKey),
      latestTimeline,
      surfaceKey,
    ),
  }));
  let loadedTimeline = loadedTimelineTracker.loaded;
  if (
    loadedTimelineTracker.latestTimeline !== latestTimeline ||
    loadedTimeline.surfaceKey !== surfaceKey
  ) {
    loadedTimeline = reconcileLoadedTimeline(
      loadedTimelineTracker.loaded,
      latestTimeline,
      surfaceKey,
    );
    setLoadedTimelineTracker({ latestTimeline, loaded: loadedTimeline });
  }
  const updateLoadedTimeline = useCallback(
    (update: (current: LoadedTimelineState) => LoadedTimelineState) => {
      setLoadedTimelineTracker((current) => {
        const loaded = update(current.loaded);
        return loaded === current.loaded ? current : { ...current, loaded };
      });
    },
    [],
  );
  const [isLoadingOlderTimelineRows, setIsLoadingOlderTimelineRows] =
    useState(false);
  const refetchLatestTimeline = latestTimelineQuery.refetch;

  const nextOlderCursor =
    loadedTimeline.surfaceKey === surfaceKey
      ? loadedTimeline.olderCursor
      : null;
  const hasOlderTimelineRows = nextOlderCursor !== null;
  const loadOlderTimelineRows = useCallback(async (): Promise<void> => {
    if (
      !enabled ||
      !nextOlderCursor ||
      !threadId ||
      isLoadingOlderTimelineRows
    ) {
      return;
    }

    setIsLoadingOlderTimelineRows(true);
    try {
      const response = await sdk.threads.timeline({
        beforeAnchorId: nextOlderCursor.anchorId,
        beforeAnchorSeq: String(nextOlderCursor.anchorSeq),
        threadId,
      });
      const olderRows = [...response.rows];
      updateLoadedTimeline((current) => {
        if (
          current.surfaceKey !== surfaceKey ||
          !areTimelinePaginationCursorsEqual({
            left: current.olderCursor,
            right: nextOlderCursor,
          })
        ) {
          return current;
        }
        return {
          ...current,
          olderCursor: response.timelinePage.olderCursor,
          rows: prependOlderTimelineRows({
            loadedRows: current.rows,
            olderRows,
          }),
        };
      });
    } catch (error) {
      if (
        !(error instanceof BbHttpError) ||
        error.status !== 400 ||
        error.code !== "invalid_request"
      ) {
        throw error;
      }

      const latestTimelineResult = await refetchLatestTimeline();
      const recoveredLatestTimeline =
        latestTimelineResult.data ?? latestTimeline;
      updateLoadedTimeline((current) => {
        if (current.surfaceKey !== surfaceKey) {
          return current;
        }
        if (!recoveredLatestTimeline) {
          return {
            ...current,
            olderCursor: null,
          };
        }
        return recoverLoadedTimelineAfterStaleCursor({
          current,
          latestTimeline: recoveredLatestTimeline,
          surfaceKey,
        });
      });
    } finally {
      setIsLoadingOlderTimelineRows(false);
    }
  }, [
    enabled,
    isLoadingOlderTimelineRows,
    latestTimeline,
    nextOlderCursor,
    refetchLatestTimeline,
    surfaceKey,
    threadId,
    updateLoadedTimeline,
  ]);
  const timelineRows =
    loadedTimeline.surfaceKey === surfaceKey && loadedTimeline.rows.length > 0
      ? loadedTimeline.rows
      : (latestTimeline?.rows ?? []);
  const timelineLoading =
    latestTimelineQuery.isLoading ||
    (latestTimelineQuery.isFetching && timelineRows.length === 0);
  const timelineError =
    timelineLoading ||
    latestTimeline !== undefined ||
    timelineRows.length > 0 ||
    !latestTimelineQuery.isLoadingError
      ? null
      : latestTimelineQuery.error;

  return {
    activeThinking: latestTimeline?.activeThinking ?? null,
    activeWorkflows: latestTimeline?.activeWorkflows ?? [],
    activeBackgroundCommands: latestTimeline?.activeBackgroundCommands ?? [],
    contextBoundarySeq: latestTimeline?.contextBoundarySeq ?? null,
    contextWindowUsage: latestTimeline?.contextWindowUsage,
    goal: latestTimeline?.goal ?? null,
    modelFallback: latestTimeline?.modelFallback ?? null,
    hasOlderTimelineRows,
    isLoadingOlderTimelineRows,
    loadOlderTimelineRows,
    pendingTodos: latestTimeline?.pendingTodos ?? null,
    timelineError,
    timelineLoading,
    timelineRows,
  };
}
