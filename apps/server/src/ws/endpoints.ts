import { terminalWebSocketQuerySchema } from "@bb/server-contract";
import type { ServerContext } from "../context.js";
import { ApiError } from "../http/errors.js";
import { authenticateRunner } from "../runners/enrollment.js";
import { attachRemoteRunner } from "../runners/remote.js";
import { attachTerminalSocket } from "../terminals/sessions.js";
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

function terminalSocket(ctx: ServerContext): SocketEndpoint {
  return ({ params, url }) => {
    const sinceSeq = url.searchParams.get("sinceSeq") ?? undefined;
    const query = terminalWebSocketQuerySchema.safeParse({ sinceSeq });
    if (!query.success) {
      throw new ApiError(
        400,
        "invalid_terminal_socket_query",
        "Terminal websocket sinceSeq must be a non-negative integer",
      );
    }
    const terminalId = params.id ?? "";
    return (socket) =>
      attachTerminalSocket(ctx, terminalId, query.data.sinceSeq, socket);
  };
}

export function registerSockets(
  sockets: SocketRegistry,
  ctx: ServerContext,
): void {
  sockets.register("/ws", realtimeSocket(ctx));
  sockets.register("/ws/terminals/:id", terminalSocket(ctx));
  sockets.register("/internal/runner/ws", runnerSocket(ctx));
}
