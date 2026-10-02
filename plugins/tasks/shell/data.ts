import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@bb/plugin/app";
import { toast } from "sonner";
import type { TasksRpcContract } from "../shared/contract.js";

const SIGNAL_BATCH_MS = 50;

export function useTasksRpc() {
  return useRpc<TasksRpcContract>();
}

export type TasksRpc = ReturnType<typeof useTasksRpc>;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function reportError(error: unknown): void {
  toast.error(errorMessage(error));
}

export function useTasksQuery<T>(
  fetcher: (rpc: TasksRpc) => Promise<T>,
  deps: readonly unknown[] = [],
) {
  const rpc = useTasksRpc();
  const key = JSON.stringify(deps);
  const initial = { key, data: undefined as T | undefined, error: "" };
  const [state, setState] = useState(initial);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const sequence = useRef(0);
  const load = useCallback(() => {
    const current = (sequence.current += 1);
    fetcherRef.current(rpc).then(
      (data) => {
        if (current === sequence.current) setState({ key, data, error: "" });
      },
      (error: unknown) => {
        if (current !== sequence.current) return;
        setState((previous) => ({
          key,
          data: previous.key === key ? previous.data : undefined,
          error: errorMessage(error),
        }));
      },
    );
  }, [rpc, key]);
  useEffect(load, [load]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const refresh = useCallback(() => {
    timer.current ??= setTimeout(() => {
      timer.current = null;
      loadRef.current();
    }, SIGNAL_BATCH_MS);
  }, []);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );
  useRealtime("tasks:changed", refresh);
  useRealtime("projects:changed", refresh);
  useRealtime("comments:changed", refresh);
  useRealtime("threads:changed", refresh);

  const connection = useRealtimeConnectionState();
  const dropped = useRef(false);
  useEffect(() => {
    if (connection !== "connected") dropped.current = true;
    else if (dropped.current) {
      dropped.current = false;
      refresh();
    }
  }, [connection, refresh]);

  const current = state.key === key;
  return {
    data: current ? state.data : undefined,
    error: current && state.error !== "" ? state.error : null,
    refresh,
  };
}

export function useOverview() {
  return useTasksQuery((rpc) => rpc.call("overview"));
}

export function useLabels(projectId?: string) {
  return useTasksQuery(
    async (rpc) =>
      (await rpc.call("listLabels", projectId ? { projectId } : {})).labels,
    [projectId],
  );
}

export function usePresets() {
  return useTasksQuery(async (rpc) => (await rpc.call("listPresets")).presets);
}
