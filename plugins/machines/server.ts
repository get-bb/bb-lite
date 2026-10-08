import { machines, type PluginServerApi } from "@bb/plugin";
import { listHosts } from "@bb/server-kit/db/hosts";
import { assertHostUsable } from "@bb/server-kit/runners/access";
import { authenticateRunner } from "@bb/server-kit/runners/enrollment";
import { ensureLocalHost, hostResponse } from "@bb/server-kit/runners/hosts";
import { provideMachines } from "./provided.js";
import { attachRemoteRunner } from "./remote.js";
import { registerHostRoutes, registerRunnerRoutes } from "./routes.js";

const RUNNER_SOCKET_PATH = "/internal/runner/ws";

export default function machinesPlugin(bb: PluginServerApi): void {
  const { db } = bb;
  bb.http.api((app) => registerHostRoutes(app, bb));
  bb.http.api((app) => registerRunnerRoutes(app, bb), { internal: true });
  bb.http.socket(({ url, principal, header }) => {
    if (url.pathname !== RUNNER_SOCKET_PATH) return null;
    const authorization = header("authorization");
    const host = authenticateRunner(db, { authorization, principal });
    return (socket) => attachRemoteRunner(bb, host.id, socket);
  });
  bb.implement(machines.list, () =>
    listHosts(db, { includeCreating: false }).map((row) =>
      hostResponse(bb, row),
    ),
  );
  bb.add(machines.guard, (hostId) => assertHostUsable(bb, hostId));
  provideMachines(bb);
  bb.onStart(() => ensureLocalHost(bb));
}
