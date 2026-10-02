import type { ClientRequest, IncomingMessage } from "node:http";
import { defineConfig, type ProxyOptions } from "vite";
import { sharedViteConfig } from "./vite.config.js";

const LOOPBACK_HOST = "127.0.0.1";
const appPort = Number(process.env.BB_DEV_APP_PORT ?? 48887);
const serverOrigin = new URL(
  process.env.BB_SERVER_URL ?? `http://${LOOPBACK_HOST}:48886`,
).origin;

function presentDevPageAsServerOrigin(
  proxyRequest: ClientRequest,
  request: IncomingMessage,
): void {
  if (request.headers.origin === `http://${request.headers.host}`) {
    proxyRequest.setHeader("origin", serverOrigin);
  }
}

const serverProxy: ProxyOptions = {
  target: serverOrigin,
  changeOrigin: true,
  configure: (proxy) => {
    proxy.on("proxyReq", presentDevPageAsServerOrigin);
    proxy.on("proxyReqWs", presentDevPageAsServerOrigin);
  },
};

export default defineConfig({
  ...sharedViteConfig,
  css: {
    transformer: "lightningcss",
  },
  server: {
    host: LOOPBACK_HOST,
    port: appPort,
    proxy: {
      "/api": serverProxy,
      "/ws": { ...serverProxy, ws: true },
    },
  },
});
