import type { ServerContext } from "../context.js";
import { authenticateRunner } from "../runners/enrollment.js";
import { attachRemoteRunner } from "../runners/remote.js";
import type { SocketEndpoint, SocketRegistry } from "./sockets.js";

function realtimeSocket({ hub }: ServerContext): SocketEndpoint {
  return () => (socket) => {
    hub.connect(socket);
    socket.on("message", (data) => hub.receive(socket, data.toString()));
    socket.on("close", () => hub.disconnect(socket));
    socket.on("error", () => hub.disconnect(socket));
  };
}

function runnerSocket(ctx: ServerContext): SocketEndpoint {
  return ({ header, principal }) => {
    const authorization = header("authorization");
    const host = authenticateRunner(ctx.db, { authorization, principal });
    return (socket) => attachRemoteRunner(ctx, host.id, socket);
  };
}

export function registerSockets(
  sockets: SocketRegistry,
  ctx: ServerContext,
): void {
  sockets.register("/ws", realtimeSocket(ctx));
  sockets.register("/internal/runner/ws", runnerSocket(ctx));
}
