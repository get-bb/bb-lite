import type { Host, HostType } from "@bb/domain";
import { publicApiRoutes } from "@bb/server-contract";
import type * as api from "@bb/server-contract";
import { flag, type Http } from "../http.js";

type Abortable = { signal?: AbortSignal };

interface HostTarget extends Abortable {
  hostId: string;
}

type HostDetail = Host & {
  connectMachineId: string | null;
  threadStorageRootPath: string | null;
};

export interface HostsArea {
  experimental_create(
    args: api.CreateMachineRequest & Abortable & { wait?: boolean },
  ): Promise<Host>;
  experimental_getEnrollmentCommand(
    args: HostTarget,
  ): Promise<api.HostEnrollmentCommandResponse>;
  experimental_reconnect(args: HostTarget): Promise<api.HostReconnectResponse>;
  delete(args: HostTarget): Promise<{ ok: true }>;
  directory(
    args: HostTarget & api.HostDirectoryQuery,
  ): Promise<api.HostDirectoryListing>;
  get(args: HostTarget): Promise<HostDetail>;
  list(
    args?: Abortable & { includeCreating?: boolean; type?: HostType },
  ): Promise<Host[]>;
  pathsExist(
    args: HostTarget & api.HostPathsExistRequest,
  ): Promise<api.HostPathsExistResponse>;
  openTargets(args: HostTarget): Promise<api.HostOpenTargetsResponse>;
  open(args: api.HostOpenRequest & { hostId: string }): Promise<void>;
  update(args: api.UpdateHostRequest & { hostId: string }): Promise<Host>;
  setSharing(
    args: api.UpdateHostSharingRequest & { hostId: string },
  ): Promise<Host>;
}

const CREATION_POLL_MS = 1000;

export function createHostsArea(http: Http): HostsArea {
  const routes = publicApiRoutes.hosts;
  const at = (hostId: string) => ({ param: { id: hostId } });
  const get: HostsArea["get"] = ({ hostId, signal }) =>
    http.json(routes.get, at(hostId), signal);
  return {
    async experimental_create({ wait, signal, ...request }) {
      const { machineProviderId, inputs, key } = request;
      const json = {
        machineProviderId,
        inputs,
        ...(key === undefined ? {} : { key }),
      };
      let host: Host = await http.json(routes.create, { json }, signal);
      if (wait === false) return host;
      for (;;) {
        signal?.throwIfAborted();
        const { phase, message } = host.lifecycle;
        if (phase === "active") return host;
        if (phase === "removing" || phase === "destroyed") {
          throw new Error(message ?? "Machine creation cancelled");
        }
        await new Promise((resolve) => setTimeout(resolve, CREATION_POLL_MS));
        host = await get({ hostId: host.id, signal });
      }
    },
    experimental_getEnrollmentCommand: ({ hostId, signal }) =>
      http.json(routes.enrollmentCommand, at(hostId), signal),
    experimental_reconnect: ({ hostId, signal }) =>
      http.json(routes.reconnect, at(hostId), signal),
    async delete({ hostId }) {
      await http.send(routes.delete, at(hostId));
      return { ok: true };
    },
    directory: ({ hostId, path, signal }) =>
      http.json(routes.directory, { ...at(hostId), query: { path } }, signal),
    get,
    list({ includeCreating, type, signal } = {}) {
      const query = { includeCreating: flag(includeCreating), type };
      return http.json(routes.list, { query }, signal);
    },
    pathsExist: ({ hostId, paths, signal }) =>
      http.json(routes.pathsExist, { ...at(hostId), json: { paths } }, signal),
    openTargets: ({ hostId, signal }) =>
      http.json(routes.openTargets, at(hostId), signal),
    async open({ hostId, ...json }) {
      await http.send(routes.open, { ...at(hostId), json });
    },
    update: ({ hostId, name }) =>
      http.json(routes.update, { ...at(hostId), json: { name } }),
    setSharing: ({ hostId, sharing }) =>
      http.json(routes.updateSharing, { ...at(hostId), json: { sharing } }),
  };
}
