import {
  environments,
  terminals as terminalOps,
  threads,
  type PluginServerApi,
} from "@bb/plugin";
import { terminalWebSocketQuerySchema } from "@bb/server-contract";
import { getTerminal } from "@bb/server-kit/db/terminals";
import { ApiError } from "@bb/server-kit/http/errors";
import { assertHostUsable } from "@bb/server-kit/runners/access";
import { registerTerminalRoutes } from "./routes.js";
import {
  attachTerminalSocket,
  closeTerminalsFor,
  requireTerminal,
  resizeTerminal,
  startTerminalSessions,
} from "./sessions.js";

const TERMINAL_PATH = /^\/ws\/terminals\/([^/]+)$/u;

export default function terminals(bb: PluginServerApi): void {
  const ctx = bb;
  bb.on(threads.released, ({ threadId, reason }) =>
    closeTerminalsFor(bb, "thread_id", threadId, reason),
  );
  bb.on(environments.released, ({ environmentId, reason }) =>
    closeTerminalsFor(bb, "environment_id", environmentId, reason),
  );
  bb.http.api((app) => registerTerminalRoutes(app, bb));
  bb.implement(terminalOps.resize, async ({ terminalId, ...size }) => {
    await resizeTerminal(ctx, requireTerminal(ctx, terminalId), size);
  });
  bb.http.socket(({ url, actor }) => {
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
