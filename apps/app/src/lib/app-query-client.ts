import { MutationCache, QueryClient } from "@tanstack/react-query";
import { isLifecycleErrorOperation } from "./lifecycle-errors";
import {
  isAbortLikeError,
  isNetworkTransportError,
  showMutationErrorToast,
} from "./mutation-errors";
import { wsManager } from "./ws";

const offline = () => wsManager.getConnectionState() !== "connected";

const isTransient = (error: unknown) =>
  isAbortLikeError(error) || isNetworkTransportError(error);

export const appQueryClient = new QueryClient({
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      const meta = mutation.meta ?? {};
      if (meta.showErrorToast === false) return;
      const { errorMessage, lifecycleOperation } = meta;
      showMutationErrorToast({
        error,
        fallbackMessage:
          typeof errorMessage === "string" ? errorMessage : "Request failed.",
        lifecycleOperation: isLifecycleErrorOperation(lifecycleOperation)
          ? lifecycleOperation
          : undefined,
      });
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 2000,
      refetchOnWindowFocus: offline,
      refetchOnReconnect: offline,
      retry: (failures, error) => failures < 2 && isTransient(error),
      retryDelay: 250,
    },
  },
});
