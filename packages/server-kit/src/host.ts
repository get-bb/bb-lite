import {
  contract,
  service,
  type PluginServerApi,
  type SocketOpen,
  type SocketRequest,
  type SocketResolver,
} from "@bb/plugin";
import type { ServerContext } from "./context.js";
import type { RouteGroup } from "./http/api.js";

export type { SocketOpen, SocketRequest, SocketResolver };
type Remove = () => void;

export interface HostServices {
  context: ServerContext;
  routes(group: RouteGroup, options?: { internal?: boolean }): Remove;
  sockets(resolver: SocketResolver): Remove;
}

export const host = contract("host", { services: service<HostServices>() });

export function coreOf(bb: PluginServerApi) {
  const services = bb.use(host.services);
  return {
    ctx: services.context,
    routes(...groups: RouteGroup[]): void {
      for (const group of groups) bb.onDispose(services.routes(group));
    },
    internalRoutes(...groups: RouteGroup[]): void {
      const internal = true;
      for (const group of groups) {
        bb.onDispose(services.routes(group, { internal }));
      }
    },
    sockets(resolver: SocketResolver): void {
      bb.onDispose(services.sockets(resolver));
    },
  };
}
