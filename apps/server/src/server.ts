import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { serve, type ServerType } from "@hono/node-server";
import { dataPaths, type ServerConfig } from "@bb/server-kit/config";
import {
  createLogger,
  type Logger,
  type ServerRunner,
} from "@bb/server-kit/context";
import type { HostContext } from "./host-context.js";
import { openDatabase, type Db } from "@bb/server-kit/db/index";
import {
  corePlugins,
  inStartOrder,
  type CorePlugin,
  type Disposer,
} from "./core/plugins.js";
import { createHttpApp } from "./http/app.js";
import { createServerKernel } from "./kernel/index.js";
import type { BuiltinPlugin } from "./plugins/builtin.js";
import { PluginHost } from "./plugins/host.js";
import { assertHostUsable } from "@bb/server-kit/runners/access";
import {
  RunnerRegistry,
  type RunnerFactory,
} from "@bb/server-kit/runners/registry";
import { socketResolver } from "./ws/endpoints.js";
import { Hub } from "@bb/server-kit/ws/hub";
import { SocketRegistry } from "./ws/sockets.js";

export type { Disposer } from "./core/plugins.js";

export interface CreateServerOptions {
  config: ServerConfig;
  localRunner: RunnerFactory<ServerRunner>;
  corePlugins?: readonly CorePlugin[];
  builtins?: BuiltinPlugin[];
  db?: Db;
  tunnelToken?: string;
  now?: () => number;
  log?: Logger;
}

export interface BbServer {
  ctx: HostContext;
  listen(): Promise<{ port: number; url: string }>;
  close(): Promise<void>;
}

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
  const { builtins } = options;
  const host = { config, db, hub, log, tunnelToken, kernel, builtins };
  const plugins = new PluginHost(host);
  const shared = { config, tunnelToken, db, hub, runners, kernel, plugins };
  const ctx = { ...shared, log, now } as unknown as HostContext;
  const core = options.corePlugins ?? corePlugins;
  for (const plugin of core) {
    const bb = kernel.scope(plugin.id, "product");
    plugin.setup?.(ctx, bb);
  }
  const app = createHttpApp(ctx, core);
  const sockets = new SocketRegistry(ctx, socketResolver(ctx));
  const disposers: Disposer[] = [];
  let http: ServerType | undefined;

  return {
    ctx,
    async listen() {
      for (const plugin of inStartOrder(core)) {
        const stop = await plugin.start?.(ctx);
        if (stop !== undefined) disposers.push(stop);
      }
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
      for (const dispose of disposers.reverse()) await dispose();
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
