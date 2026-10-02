import { useSyncExternalStore } from "react";
import { wsManager, type WebSocketConnectionState } from "@/lib/ws";

export function useServerConnectionState(): WebSocketConnectionState {
  return useSyncExternalStore(wsManager.onConnectionStateChange, () =>
    wsManager.getConnectionState(),
  );
}
