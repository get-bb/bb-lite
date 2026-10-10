import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type * as Plugin from "@bb/plugin";
import { connect } from "./contract.js";

export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const HOP_HEADERS = /^(connection|keep-alive|transfer-encoding|upgrade)$/iu;
const NO_WEBSOCKETS =
  "bb connect does not carry WebSockets to ports shared from another " +
  "machine yet; share the port from the machine that runs the bb server.";

export interface RemoteShare {
  hostId: string;
  port: number;
}

type Runners = Pick<Plugin.Runners, "call" | "isConnected">;

function answer(response: ServerResponse, status: number, text: string) {
  const headers = { "content-type": "text/plain; charset=utf-8" };
  response.writeHead(status, headers).end(`${text}\n`);
}

async function collect(request: IncomingMessage): Promise<Buffer | null> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += part.byteLength;
    if (size > MAX_REQUEST_BYTES) return null;
    parts.push(part);
  }
  return Buffer.concat(parts);
}

export async function proxyRemote(
  runners: Runners,
  share: RemoteShare,
  request: IncomingMessage,
  response: ServerResponse,
  ownOrigin: string,
): Promise<void> {
  const { hostId, port } = share;
  const where = `port ${port} on machine ${hostId}`;
  const abort = new AbortController();
  response.once("close", () => abort.abort());
  const { signal } = abort;
  if (!runners.isConnected(hostId)) {
    return answer(response, 502, `Cannot reach ${where}: it is offline.`);
  }
  const body = await collect(request);
  if (body === null) {
    return answer(response, 413, "The request body is larger than 32 MiB.");
  }
  const target = `http://127.0.0.1:${port}`;
  const raw = request.rawHeaders;
  const headers = raw.flatMap((name, index): [string, string][] => {
    const value = raw[index + 1];
    if (index % 2 !== 0 || value === undefined || HOP_HEADERS.test(name)) {
      return [];
    }
    const origin = /^origin$/iu.test(name) && value === ownOrigin;
    return [[name, origin ? target : value]];
  });
  const options = { signal };
  let id: string | null = null;
  try {
    const method = request.method ?? "GET";
    const path = request.url ?? "/";
    const sent = { port, method, path, headers };
    const bodyText = body.byteLength > 0 ? body.toString("base64") : undefined;
    const input = bodyText === undefined ? sent : { ...sent, body: bodyText };
    const head = await runners.call(
      hostId,
      connect.shareRequest,
      input,
      options,
    );
    const kept = head.headers.filter(([name]) => !HOP_HEADERS.test(name));
    response.writeHead(head.status, kept.flat());
    let reply = { id: head.id, data: head.data, done: head.done };
    id = reply.done ? null : reply.id;
    for (;;) {
      const data = Buffer.from(reply.data, "base64");
      if (data.byteLength > 0 && !response.write(data)) {
        await new Promise((resolve) => {
          response.once("drain", resolve);
          response.once("close", resolve);
        });
      }
      if (reply.done || signal.aborted) break;
      const next = { id: reply.id };
      reply = await runners.call(hostId, connect.shareChunk, next, options);
      id = reply.done ? null : reply.id;
    }
    response.end();
  } catch (error) {
    if (response.headersSent) response.destroy();
    else {
      const reason = error instanceof Error ? error.message : String(error);
      answer(response, 502, `Cannot reach ${where}: ${reason}`);
    }
  } finally {
    if (id !== null) {
      const closing = runners.call(hostId, connect.shareClose, { id });
      closing.catch(() => undefined);
    }
  }
}

export async function listenRemote(
  runners: Runners,
  share: RemoteShare,
): Promise<{ server: Server; origin: string }> {
  let origin = "";
  const server = createServer((request, response) => {
    void proxyRemote(runners, share, request, response, origin);
  });
  server.on("upgrade", (_request, socket) => {
    const text = `${NO_WEBSOCKETS}\n`;
    const head = [
      "HTTP/1.1 501 Not Implemented",
      "content-type: text/plain; charset=utf-8",
      `content-length: ${Buffer.byteLength(text)}`,
      "connection: close",
    ];
    socket.end(`${head.join("\r\n")}\r\n\r\n${text}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
  return { server, origin };
}
