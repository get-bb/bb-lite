import { terminals, type PluginServerApi } from "@bb/plugin";
import * as sessions from "./sessions.js";

export function implementTerminals(bb: PluginServerApi): void {
  bb.implement(terminals.list, (query) => ({
    sessions: sessions.listTerminalSessions(bb, query),
  }));

  bb.implement(terminals.create, (request) =>
    sessions.createTerminal(bb, request),
  );

  bb.implement(terminals.get, ({ terminalId }) =>
    sessions.requireTerminal(bb, terminalId),
  );

  bb.implement(terminals.update, ({ terminalId, title }) => {
    const session = sessions.requireTerminal(bb, terminalId);
    return sessions.changeTerminal(bb, session, { title });
  });

  bb.implement(terminals.close, ({ terminalId, ...request }) =>
    sessions.closeTerminal(bb, terminalId, request),
  );

  bb.implement(terminals.write, ({ terminalId, dataBase64 }) => {
    const session = sessions.requireRunning(bb, terminalId);
    return sessions.writeTerminalInput(bb, session, dataBase64);
  });

  bb.implement(terminals.output, ({ terminalId, ...query }) =>
    sessions.readTerminalOutput(bb, terminalId, query),
  );
}
