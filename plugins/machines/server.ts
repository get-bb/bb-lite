import { machines, type PluginServerApi } from "@bb/plugin";
import { listHosts } from "@bb/server-kit/db/hosts";
import { coreOf } from "@bb/server-kit/host";
import { authenticateRunner } from "@bb/server-kit/runners/enrollment";
import { ensureLocalHost, hostResponse } from "@bb/server-kit/runners/hosts";
import { attachRemoteRunner } from "./remote.js";
import { registerHostRoutes, registerRunnerRoutes } from "./routes.js";

const RUNNER_SOCKET_PATH = "/internal/runner/ws";

export default function machinesPlugin(bb: PluginServerApi): void {
  const { ctx, routes, internalRoutes, sockets } = coreOf(bb);
  const { db } = ctx;
  routes(registerHostRoutes);
  internalRoutes(registerRunnerRoutes);
  sockets(({ url, principal, header }) => {
    if (url.pathname !== RUNNER_SOCKET_PATH) return null;
    const authorization = header("authorization");
    const host = authenticateRunner(db, { authorization, principal });
    return (socket) => attachRemoteRunner(ctx, host.id, socket);
  });
  bb.implement(machines.list, () =>
    listHosts(db, { includeCreating: false }).map((row) =>
      hostResponse(ctx, row),
    ),
  );
  bb.onStart(() => ensureLocalHost(ctx));
}
