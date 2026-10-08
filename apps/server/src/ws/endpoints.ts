import type { HostContext } from "../host-context.js";
import type { SocketOpen, SocketResolver } from "@bb/server-kit/host";
import { notFound } from "@bb/server-kit/http/errors";

export type RequiredSocketResolver = (
  request: Parameters<SocketResolver>[0],
) => SocketOpen;

export function socketResolver(
  ctx: HostContext,
  resolvers: ReadonlySet<SocketResolver>,
): RequiredSocketResolver {
  const { hub } = ctx;
  return (request) => {
    const { url, actor } = request;
    if (url.pathname === "/ws") {
      return (socket) => {
        hub.connect(socket, actor?.userId ?? null);
        socket.on("message", (data) => hub.receive(socket, data.toString()));
        socket.on("close", () => hub.disconnect(socket));
        socket.on("error", () => hub.disconnect(socket));
      };
    }
    for (const resolve of resolvers) {
      const open = resolve(request);
      if (open !== null) return open;
    }
    throw notFound();
  };
}
