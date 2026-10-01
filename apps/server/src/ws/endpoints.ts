import type { ServerContext } from "../context.js";
import type { SocketEndpoint, SocketRegistry } from "./sockets.js";

function realtimeSocket({ hub }: ServerContext): SocketEndpoint {
  return () => (socket) => {
    hub.connect(socket);
    socket.on("message", (data) => hub.receive(socket, data.toString()));
    socket.on("close", () => hub.disconnect(socket));
    socket.on("error", () => hub.disconnect(socket));
  };
}

export function registerSockets(
  sockets: SocketRegistry,
  ctx: ServerContext,
): void {
  sockets.register("/ws", realtimeSocket(ctx));
}
