import { terminalWebSocketQuerySchema } from "@bb/server-contract";
import type { ServerContext } from "@bb/server-kit/context";
import { getTerminal } from "@bb/server-kit/db/terminals";
import { ApiError, notFound } from "@bb/server-kit/http/errors";
import { assertHostUsable } from "@bb/server-kit/runners/access";
import { authenticateRunner } from "@bb/server-kit/runners/enrollment";
import { attachRemoteRunner } from "../runners/remote.js";
import { attachTerminalSocket } from "../terminals/sessions.js";
import type { SocketResolver } from "./sockets.js";

const TERMINAL_PATH = /^\/ws\/terminals\/([^/]+)$/u;

export function socketResolver(ctx: ServerContext): SocketResolver {
  const { hub } = ctx;
  return ({ url, principal, actor, header }) => {
    const terminal = TERMINAL_PATH.exec(url.pathname);
    if (url.pathname === "/ws") {
      return (socket) => {
        hub.connect(socket, actor?.userId ?? null);
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
    const session = getTerminal(ctx.db, terminalId);
    if (session !== undefined) assertHostUsable(ctx, session.hostId, actor);
    return (socket) =>
      attachTerminalSocket(ctx, terminalId, query.data.sinceSeq, socket);
  };
}
