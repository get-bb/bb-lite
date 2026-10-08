import type { PluginServerApi } from "@bb/plugin";
import { terminalWebSocketQuerySchema } from "@bb/server-contract";
import { getTerminal } from "@bb/server-kit/db/terminals";
import { coreOf } from "@bb/server-kit/host";
import { ApiError } from "@bb/server-kit/http/errors";
import { assertHostUsable } from "@bb/server-kit/runners/access";
import { registerTerminalRoutes } from "./routes.js";
import {
  attachTerminalSocket,
  closeTerminalsFor,
  startTerminalSessions,
} from "./sessions.js";

const TERMINAL_PATH = /^\/ws\/terminals\/([^/]+)$/u;

export default function terminals(bb: PluginServerApi): void {
  const { ctx, routes, sockets } = coreOf(bb);
  ctx.terminals = {
    closeFor: (owner, id, reason) => closeTerminalsFor(ctx, owner, id, reason),
  };
  routes(registerTerminalRoutes);
  sockets(({ url, actor }) => {
    const terminal = TERMINAL_PATH.exec(url.pathname);
    if (terminal === null) return null;
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
  });
  bb.onStart(() => startTerminalSessions(ctx));
}
