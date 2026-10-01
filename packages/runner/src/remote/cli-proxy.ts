import { once } from "node:events";
import http, { type ServerResponse } from "node:http";
import https from "node:https";

export interface CliProxyOptions {
  serverUrl: string;
  headers: Record<string, string>;
  runnerToken: string;
}

export interface CliProxy {
  url: string;
  close(): Promise<void>;
}

const API_PREFIX = "/api/v1/";
const HOP_BY_HOP_HEADER =
  /^(?:host|connection|keep-alive|proxy-.+|te|trailer|transfer-encoding|upgrade)$/u;
const REFUSALS = {
  403: ["forbidden", "This proxy only serves the bb CLI on this machine"],
  404: ["not_found", "Not found"],
  502: ["server_unreachable", "The bb server is unreachable"],
} as const;

function refuse(response: ServerResponse, status: keyof typeof REFUSALS) {
  const [code, message] = REFUSALS[status];
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ code, message }));
}

export async function startCliProxy(
  options: CliProxyOptions,
): Promise<CliProxy> {
  const upstream = new URL(options.serverUrl);
  const { request } = upstream.protocol === "https:" ? https : http;
  let ownAuthorities: string[] = [];

  const server = http.createServer((incoming, response) => {
    const { headers, method, url = "/" } = incoming;
    const fromBrowser =
      headers.origin !== undefined || headers["sec-fetch-site"] !== undefined;
    if (fromBrowser || !ownAuthorities.includes(headers.host ?? "")) {
      return refuse(response, 403);
    }
    const target = new URL(url, upstream);
    const ownApi = target.origin === upstream.origin;
    if (!ownApi || !target.pathname.startsWith(API_PREFIX)) {
      return refuse(response, 404);
    }
    const forwarded: http.OutgoingHttpHeaders = { ...options.headers };
    for (const [name, value] of Object.entries(headers)) {
      if (!HOP_BY_HOP_HEADER.test(name)) forwarded[name] ??= value;
    }
    forwarded.authorization = `Bearer ${options.runnerToken}`;
    const outgoing = request(target, { method, headers: forwarded });
    outgoing.on("response", (reply) => {
      response.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(response);
    });
    outgoing.on("error", () => {
      if (response.headersSent) response.destroy();
      else refuse(response, 502);
    });
    response.on("close", () => outgoing.destroy());
    incoming.pipe(outgoing);
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The CLI proxy is not listening on a TCP port");
  }
  ownAuthorities = ["127.0.0.1", "localhost"].map(
    (name) => `${name}:${address.port}`,
  );
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
