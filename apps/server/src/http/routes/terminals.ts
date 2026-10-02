import { publicApiRoutes } from "@bb/server-contract";
import type { ServerContext } from "../../context.js";
import * as sessions from "../../terminals/sessions.js";
import { typedApi, type ApiApp } from "../api.js";

export function registerTerminalRoutes(app: ApiApp, ctx: ServerContext): void {
  const { get, patch, post } = typedApi(app);
  const routes = publicApiRoutes.terminals;

  get(routes.list, (c, query) =>
    c.json({ sessions: sessions.listTerminalSessions(ctx, query) }),
  );

  post(routes.create, async (c, payload) =>
    c.json(await sessions.createTerminal(ctx, payload), 201),
  );

  get(routes.get, (c) =>
    c.json(sessions.requireTerminal(ctx, c.req.param("terminalId"))),
  );

  patch(routes.update, (c, { title }) => {
    const session = sessions.requireTerminal(ctx, c.req.param("terminalId"));
    return c.json(sessions.changeTerminal(ctx, session, { title }));
  });

  post(routes.close, (c, payload) =>
    c.json(sessions.closeTerminal(ctx, c.req.param("terminalId"), payload)),
  );

  post(routes.input, async (c, { dataBase64 }) => {
    const session = sessions.requireRunning(ctx, c.req.param("terminalId"));
    return c.json(await sessions.writeTerminalInput(ctx, session, dataBase64));
  });

  post(routes.resize, async (c, size) => {
    const session = sessions.requireRunning(ctx, c.req.param("terminalId"));
    return c.json(await sessions.resizeTerminal(ctx, session, size));
  });

  get(routes.output, async (c, query) => {
    const terminalId = c.req.param("terminalId");
    return c.json(await sessions.readTerminalOutput(ctx, terminalId, query));
  });
}
