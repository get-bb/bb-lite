interface QuerySnapshot {
  hasResolvedData: boolean;
  isFetching: boolean;
  isLoadingError: boolean;
  isRecoverableLoadingError?: boolean;
}

export function useConnectionAwareQueryState(snapshot: QuerySnapshot): {
  status: "loading" | "ready" | "unavailable";
} {
  const { hasResolvedData, isFetching, isLoadingError } = snapshot;
  if (hasResolvedData) return { status: "ready" };
  if (isFetching) return { status: "loading" };
  return { status: isLoadingError ? "unavailable" : "ready" };
}
