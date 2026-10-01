import type { WebSocket } from "ws";
import type { ServerContext } from "../context.js";

const TRY_AGAIN_LATER_CLOSE_CODE = 1013;

export function attachRemoteRunner(
  _ctx: ServerContext,
  _hostId: string,
  socket: WebSocket,
): void {
  socket.close(
    TRY_AGAIN_LATER_CLOSE_CODE,
    "remote runner transport not installed",
  );
}
