import { once } from "node:events";
import { serve, type ServerType } from "@hono/node-server";
import { dataPaths, type ServerConfig } from "./config.js";
import {
  createLogger,
  type Logger,
  type ServerContext,
  type ServerRunner,
} from "./context.js";
import { openDatabase, type Db } from "./db/index.js";
import { ensurePersonalProject } from "./db/projects.js";
import { createBasicEnvironments } from "./environments/basic.js";
import { startWorkspaceWatch } from "./environments/watch.js";
import { createHttpApp } from "./http/app.js";
import { PluginHost, startPlugins } from "./plugins/host.js";
import { ensureLocalHost } from "./runners/hosts.js";
import { RunnerRegistry, type RunnerFactory } from "./runners/registry.js";
import { startTerminalSessions } from "./terminals/sessions.js";
import { createThreadEngine } from "./threads/engine.js";
import { createNoExtensions } from "./threads/extensions.js";
import { registerSockets } from "./ws/endpoints.js";
import { Hub } from "./ws/hub.js";
import { SocketRegistry } from "./ws/sockets.js";

export type Disposer = () => void | Promise<void>;
export type StartupStep = (
  ctx: ServerContext,
) => void | Disposer | Promise<void | Disposer>;

export const startupSteps: StartupStep[] = [
  ensureLocalHost,
  (ctx) => ensurePersonalProject(ctx.db),
  startPlugins,
  startTerminalSessions,
  startWorkspaceWatch,
];

export interface CreateServerOptions {
  config: ServerConfig;
  localRunner: RunnerFactory<ServerRunner>;
  db?: Db;
  now?: () => number;
  log?: Logger;
}

export interface BbServer {
  ctx: ServerContext;
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
  const runners = new RunnerRegistry({ localHostId, localRunner, log });
  runners.onConnected((hostId) => hub.host(hostId, ["host-connected"]));
  runners.onDisconnected((hostId) => hub.host(hostId, ["host-disconnected"]));
  const plugins = new PluginHost({ config, db, hub, log });
  const environments = createBasicEnvironments({ db, hub, runners });
  const extensions = createNoExtensions();
  const services = { plugins, environments, extensions };
  const base = { config, db, hub, runners, log, now, ...services };
  const threads = createThreadEngine(base);
  const ctx: ServerContext = Object.assign(base, { threads });
  const app = createHttpApp(ctx);
  const sockets = new SocketRegistry(ctx);
  registerSockets(sockets, ctx);
  const disposers: Disposer[] = [];
  let http: ServerType | undefined;

  return {
    ctx,
    async listen() {
      ctx.threads.start();
      disposers.push(() => ctx.threads.close());
      for (const step of startupSteps) {
        const dispose = await step(ctx);
        if (dispose !== undefined) disposers.push(dispose);
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
