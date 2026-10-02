export const RESUME_REFETCH_QUERY_POLICY = {
  refetchOnReconnect: true,
  refetchOnWindowFocus: true,
} as const;

export const REALTIME_OWNED_NO_FOCUS_QUERY_POLICY = {
  refetchOnWindowFocus: false,
} as const;

export const HEAVY_PAYLOAD_GC_TIME_MS = 60_000;
