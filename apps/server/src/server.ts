import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { serve, type ServerType } from "@hono/node-server";
import { dataPaths, type ServerConfig } from "@bb/server-kit/config";
import {
  createLogger,
  type Disposer,
  type Logger,
  type ServerRunner,
} from "@bb/server-kit/context";
import { openDatabase, type OpenDatabase } from "@bb/server-kit/db/index";
import type { ApiRoutes, SocketResolver } from "@bb/plugin";
import { assertHostUsable } from "@bb/server-kit/runners/access";
import {
  RunnerRegistry,
  type RunnerFactory,
} from "@bb/server-kit/runners/registry";
import { Hub } from "@bb/server-kit/ws/hub";
import type { HostContext } from "./host-context.js";
import { createHttpApp, RouteTable } from "./http/app.js";
import { registerKernelRoutes } from "./http/routes/kernel.js";
import { registerPluginRoutes } from "./http/routes/plugins.js";
import { createServerKernel } from "./kernel/index.js";
import {
  builtinPlugins,
  corePlugins,
  type BuiltinPlugin,
} from "./plugins/builtin.js";
import { PluginHost, startPlugins } from "./plugins/host.js";
import { hostOps } from "./plugins/ops.js";
import { socketResolver } from "./ws/endpoints.js";
import { SocketRegistry } from "./ws/sockets.js";

export type { Disposer };

export interface CreateServerOptions {
  config: ServerConfig;
  localRunner: RunnerFactory<ServerRunner>;
  core?: BuiltinPlugin[];
  builtins?: BuiltinPlugin[];
  db?: OpenDatabase;
  tunnelToken?: string;
  now?: () => number;
  log?: Logger;
}

export interface BbServer {
  ctx: HostContext;
  listen(): Promise<{ port: number; url: string }>;
  close(): Promise<void>;
}

const HOST_PLUGIN_ID = "plugins";

export function createServer(options: CreateServerOptions): BbServer {
  const { config } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? createLogger(config.logLevel);
  const path = dataPaths(config.dataDir).database;
  const db = options.db ?? openDatabase({ path, now });
  const hub = new Hub();
  const { hostId: localHostId } = config;
  const { localRunner } = options;
  const authorize = (hostId: string) => assertHostUsable(ctx, hostId);
  const access = { localHostId, localRunner, log, authorize };
  const runners = new RunnerRegistry(access);
  runners.onConnected((hostId) => hub.host(hostId, ["host-connected"]));
  runners.onDisconnected((hostId) => hub.host(hostId, ["host-disconnected"]));
  const tunnelToken =
    options.tunnelToken ?? randomBytes(24).toString("base64url");
  const kernel = createServerKernel({ db, hub, log, now });
  const { core = corePlugins, builtins: addOns = builtinPlugins } = options;
  const builtins = [...core.map((row) => ({ ...row, core: true })), ...addOns];
  const table = new RouteTable();
  const resolvers = new Set<SocketResolver>();
  const mounting = {
    routes: (routes: ApiRoutes, internal: boolean) =>
      table.add(routes, internal),
    sockets(resolver: SocketResolver) {
      resolvers.add(resolver);
      return () => void resolvers.delete(resolver);
    },
  };
  const services = { config, db, hub, log, tunnelToken, kernel, runners, now };
  const plugins = new PluginHost({ ...services, ...mounting, builtins });
  const own = kernel.scope(HOST_PLUGIN_ID, "product");
  const shared = { config, tunnelToken, db, hub, runners, kernel, plugins };
  const ctx: HostContext = { ...own, ...shared, realtime: hub, log, now };
  hostOps(ctx, own);
  table.add((app) => registerPluginRoutes(app, ctx));
  table.add((app) => registerKernelRoutes(app, ctx));
  const app = createHttpApp(ctx, table);
  plugins.fetch = (request) => app.inner(request);
  const sockets = new SocketRegistry(ctx, socketResolver(ctx, resolvers));
  let stopPlugins: Disposer | undefined;
  let http: ServerType | undefined;

  return {
    ctx,
    async listen() {
      stopPlugins = await startPlugins(ctx);
      const { port, bindHost: hostname } = config;
      http = serve({ fetch: app.fetch, port, hostname });
      http.on("upgrade", sockets.handleUpgrade);
      await once(http, "listening");
      const address = http.address();
      if (address === null || typeof address === "string") {
        throw new Error("Server is not listening on a TCP port");
      }
      const host = hostname === "0.0.0.0" ? "127.0.0.1" : hostname;
      return { port: address.port, url: `http://${host}:${address.port}` };
    },
    async close() {
      const closed = sockets.close();
      hub.close();
      await stopPlugins?.();
      if (http !== undefined) {
        const server = http;
        if ("closeAllConnections" in server) server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      await closed;
      db.close();
    },
  };
}
