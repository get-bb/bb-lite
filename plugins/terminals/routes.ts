import type { PluginServerApi } from "@bb/plugin";
import { publicApiRoutes } from "@bb/server-contract";
import * as sessions from "./sessions.js";
import { typedApi, type ApiApp } from "@bb/server-kit/http/api";

export function registerTerminalRoutes(app: ApiApp, bb: PluginServerApi): void {
  const { get, patch, post } = typedApi(app);
  const routes = publicApiRoutes.terminals;

  get(routes.list, (c, query) =>
    c.json({ sessions: sessions.listTerminalSessions(bb, query) }),
  );

  post(routes.create, async (c, payload) =>
    c.json(await sessions.createTerminal(bb, payload), 201),
  );

  get(routes.get, (c) =>
    c.json(sessions.requireTerminal(bb, c.req.param("terminalId"))),
  );

  patch(routes.update, (c, { title }) => {
    const session = sessions.requireTerminal(bb, c.req.param("terminalId"));
    return c.json(sessions.changeTerminal(bb, session, { title }));
  });

  post(routes.close, (c, payload) =>
    c.json(sessions.closeTerminal(bb, c.req.param("terminalId"), payload)),
  );

  post(routes.input, async (c, { dataBase64 }) => {
    const session = sessions.requireRunning(bb, c.req.param("terminalId"));
    return c.json(await sessions.writeTerminalInput(bb, session, dataBase64));
  });

  get(routes.output, async (c, query) => {
    const terminalId = c.req.param("terminalId");
    return c.json(await sessions.readTerminalOutput(bb, terminalId, query));
  });
}
