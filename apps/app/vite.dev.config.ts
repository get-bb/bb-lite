import type { ClientRequest, IncomingMessage } from "node:http";
import { defineConfig, type ProxyOptions } from "vite";
import { sharedViteConfig } from "./vite.config.js";

const LOOPBACK_HOST = "127.0.0.1";
const LOOPBACK_AUTHORITY = /^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/u;
const appPort = Number(process.env.BB_DEV_APP_PORT ?? 48887);
const serverUrl = new URL(
  process.env.BB_SERVER_URL ?? `http://${LOOPBACK_HOST}:48886`,
);

function presentDevPageAsServerPage(
  proxyRequest: ClientRequest,
  request: IncomingMessage,
): void {
  const { host, origin } = request.headers;
  if (host === undefined || !LOOPBACK_AUTHORITY.test(host)) {
    return;
  }
  proxyRequest.setHeader("host", serverUrl.host);
  if (origin === `http://${host}`) {
    proxyRequest.setHeader("origin", serverUrl.origin);
  }
}

const serverProxy: ProxyOptions = {
  target: serverUrl.origin,
  configure: (proxy) => {
    proxy.on("proxyReq", presentDevPageAsServerPage);
    proxy.on("proxyReqWs", presentDevPageAsServerPage);
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
