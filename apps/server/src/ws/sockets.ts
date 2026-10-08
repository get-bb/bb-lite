import { STATUS_CODES, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { HostContext } from "../host-context.js";
import type { SocketOpen } from "@bb/plugin";
import { authenticatorOf } from "../http/app.js";
import type { RequiredSocketResolver } from "./endpoints.js";
import { errorResponse } from "@bb/server-kit/http/errors";
import { requestHeader } from "@bb/server-kit/http/trust";
import { THREAD_ID_HEADER } from "@bb/server-kit/runners/access";

const SHUTDOWN_CLOSE_CODE = 1001;
const SHUTDOWN_GRACE_MS = 1_000;

async function refuse(socket: Duplex, response: Response) {
  const body = await response.text();
  socket.end(
    `HTTP/1.1 ${response.status} ${STATUS_CODES[response.status] ?? ""}\r\n` +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "Connection: close\r\n\r\n" +
      body,
  );
}

export class SocketRegistry {
  private readonly server = new WebSocketServer({ noServer: true });

  constructor(
    private readonly ctx: HostContext,
    private readonly resolve: RequiredSocketResolver,
  ) {}

  readonly handleUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    const url = new URL(request.url ?? "/", "http://localhost");
    this.accept(request, url)
      .then((open) => this.server.handleUpgrade(request, socket, head, open))
      .catch((error: unknown) => {
        const route = { method: "UPGRADE", path: url.pathname };
        return refuse(socket, errorResponse(error, this.ctx.log, route));
      })
      .catch(() => socket.destroy());
  };

  async close(): Promise<void> {
    for (const client of this.server.clients) {
      client.close(SHUTDOWN_CLOSE_CODE, "server-shutdown");
    }
    const terminate = setTimeout(() => {
      for (const client of this.server.clients) client.terminate();
    }, SHUTDOWN_GRACE_MS);
    await new Promise((resolve) => this.server.close(resolve));
    clearTimeout(terminate);
  }

  private async accept(
    request: IncomingMessage,
    url: URL,
  ): Promise<SocketOpen> {
    const { headers, socket } = request;
    const path = url.pathname;
    const authenticator = authenticatorOf(this.ctx);
    const identity = { method: "GET", path, headers, socket };
    const principal = authenticator.principal(identity);
    const header = (name: string) => requestHeader(request, name);
    const actor = authenticator.actor(principal, header(THREAD_ID_HEADER));
    return this.resolve({ url, principal, actor, header });
  }
}
