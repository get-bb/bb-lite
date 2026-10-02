import { publicApiRoutes } from "@bb/server-contract";
import type { ServerContext } from "../../context.js";
import {
  closeTerminal,
  createTerminal,
  listTerminalSessions,
  readTerminalOutput,
  renameTerminal,
  requireTerminal,
  resizeTerminal,
  sendTerminalInput,
} from "../../terminals/sessions.js";
import { typedApi, type ApiApp } from "../api.js";

export function registerTerminalRoutes(app: ApiApp, ctx: ServerContext): void {
  const { get, patch, post } = typedApi(app);
  const routes = publicApiRoutes.terminals;

  get(routes.list, (c, query) =>
    c.json({ sessions: listTerminalSessions(ctx, query) }),
  );

  post(routes.create, async (c, payload) =>
    c.json(await createTerminal(ctx, payload), 201),
  );

  get(routes.get, (c) =>
    c.json(requireTerminal(ctx, c.req.param("terminalId"))),
  );

  patch(routes.update, (c, payload) =>
    c.json(renameTerminal(ctx, c.req.param("terminalId"), payload.title)),
  );

  post(routes.close, (c, payload) =>
    c.json(closeTerminal(ctx, c.req.param("terminalId"), payload)),
  );

  post(routes.input, async (c, { dataBase64 }) => {
    const terminalId = c.req.param("terminalId");
    return c.json(await sendTerminalInput(ctx, terminalId, dataBase64));
  });

  post(routes.resize, async (c, size) =>
    c.json(await resizeTerminal(ctx, c.req.param("terminalId"), size)),
  );

  get(routes.output, async (c, query) => {
    const terminalId = c.req.param("terminalId");
    return c.json(await readTerminalOutput(ctx, terminalId, query));
  });
}
