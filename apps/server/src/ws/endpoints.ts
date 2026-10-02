import { terminalWebSocketQuerySchema } from "@bb/server-contract";
import type { ServerContext } from "../context.js";
import { ApiError, notFound } from "../http/errors.js";
import { authenticateRunner } from "../runners/enrollment.js";
import { attachRemoteRunner } from "../runners/remote.js";
import { attachTerminalSocket } from "../terminals/sessions.js";
import type { SocketResolver } from "./sockets.js";

const TERMINAL_PATH = /^\/ws\/terminals\/([^/]+)$/u;

export function socketResolver(ctx: ServerContext): SocketResolver {
  const { hub } = ctx;
  return ({ url, principal, header }) => {
    const terminal = TERMINAL_PATH.exec(url.pathname);
    if (url.pathname === "/ws") {
      return (socket) => {
        hub.connect(socket);
        socket.on("message", (data) => hub.receive(socket, data.toString()));
        socket.on("close", () => hub.disconnect(socket));
        socket.on("error", () => hub.disconnect(socket));
      };
    }
    if (url.pathname === "/internal/runner/ws") {
      const authorization = header("authorization");
      const host = authenticateRunner(ctx.db, { authorization, principal });
      return (socket) => attachRemoteRunner(ctx, host.id, socket);
    }
    if (terminal === null) throw notFound();
    const sinceSeq = url.searchParams.get("sinceSeq") ?? undefined;
    const query = terminalWebSocketQuerySchema.safeParse({ sinceSeq });
    if (!query.success) {
      throw new ApiError(
        400,
        "invalid_terminal_socket_query",
        "Terminal websocket sinceSeq must be a non-negative integer",
      );
    }
    const terminalId = decodeURIComponent(terminal[1] ?? "");
    return (socket) =>
      attachTerminalSocket(ctx, terminalId, query.data.sinceSeq, socket);
  };
}
