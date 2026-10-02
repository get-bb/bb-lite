import type { Host, HostType } from "@bb/domain";
import type {
  CreateMachineRequest,
  HostEnrollmentCommandResponse,
  HostReconnectResponse,
  HostDirectoryListing,
  HostDirectoryQuery,
  HostOpenRequest,
  HostOpenTargetsResponse,
  HostPathsExistRequest,
  HostPathsExistResponse,
  UpdateHostRequest,
} from "@bb/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export interface HostGetArgs {
  hostId: string;
  signal?: AbortSignal;
}

export interface HostDeleteArgs {
  hostId: string;
}

export interface HostUpdateArgs extends UpdateHostRequest {
  hostId: string;
}

export interface HostActionArgs {
  hostId: string;
}

export interface HostReconnectArgs extends HostActionArgs {
  signal?: AbortSignal;
}

export interface HostDirectoryArgs extends HostDirectoryQuery {
  hostId: string;
  signal?: AbortSignal;
}

export interface HostPathsExistArgs extends HostPathsExistRequest {
  hostId: string;
  signal?: AbortSignal;
}

export interface HostOpenArgs extends HostOpenRequest {
  hostId: string;
}

export interface HostListArgs {
  includeCreating?: boolean;
  type?: HostType;
  signal?: AbortSignal;
}

export interface MachineCreateArgs extends CreateMachineRequest {
  wait?: boolean;
  signal?: AbortSignal;
}
export type HostDeleteResult = { ok: true };
export type HostDirectoryResult = HostDirectoryListing;
export type HostGetResult = Host & {
  connectMachineId: string | null;
  threadStorageRootPath: string | null;
};
export type HostEnrollmentCommandResult = HostEnrollmentCommandResponse;
export type HostReconnectResult = HostReconnectResponse;
export type HostListResult = Host[];
export type HostPathsExistResult = HostPathsExistResponse;
export type HostUpdateResult = Host;

export interface HostsArea {
  experimental_create(args: MachineCreateArgs): Promise<Host>;
  experimental_getEnrollmentCommand(
    args: HostGetArgs,
  ): Promise<HostEnrollmentCommandResult>;
  experimental_reconnect(args: HostReconnectArgs): Promise<HostReconnectResult>;
  delete(args: HostDeleteArgs): Promise<HostDeleteResult>;
  directory(args: HostDirectoryArgs): Promise<HostDirectoryResult>;
  get(args: HostGetArgs): Promise<HostGetResult>;
  list(args?: HostListArgs): Promise<HostListResult>;
  pathsExist(args: HostPathsExistArgs): Promise<HostPathsExistResult>;
  openTargets(args: HostGetArgs): Promise<HostOpenTargetsResponse>;
  open(args: HostOpenArgs): Promise<void>;
  update(args: HostUpdateArgs): Promise<HostUpdateResult>;
}

export function createHostsArea(args: CreateSdkAreaArgs): HostsArea {
  const { transport } = args;
  return {
    async experimental_create(input) {
      let host = await transport.readJson(
        transport.api.v1.hosts.$post(
          {
            json: {
              machineProviderId: input.machineProviderId,
              inputs: input.inputs,
              ...(input.key === undefined ? {} : { key: input.key }),
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
      if (input.wait === false) return host;
      for (;;) {
        input.signal?.throwIfAborted();
        if (host.lifecycle.phase === "active") return host;
        if (
          host.lifecycle.phase === "removing" ||
          host.lifecycle.phase === "destroyed"
        )
          throw new Error(
            host.lifecycle.message ?? "Machine creation cancelled",
          );
        await new Promise<void>((resolve) => setTimeout(resolve, 1000));
        host = await this.get({ hostId: host.id, signal: input.signal });
      }
    },
    async experimental_getEnrollmentCommand(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"]["enrollment-command"].$get(
          {
            param: { id: input.hostId },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async experimental_reconnect(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"]["reconnect-commands"].$post(
          { param: { id: input.hostId } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async delete(input) {
      await transport.readVoid(
        transport.api.v1.hosts[":id"].$delete({
          param: { id: input.hostId },
        }),
      );
      return { ok: true };
    },
    async directory(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"].directory.$get(
          {
            param: { id: input.hostId },
            query: { path: input.path },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async get(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"].$get(
          {
            param: { id: input.hostId },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async list(input) {
      return transport.readJson(
        transport.api.v1.hosts.$get(
          {
            query: {
              ...(input?.includeCreating === undefined
                ? {}
                : {
                    includeCreating: input.includeCreating ? "true" : "false",
                  }),
              ...(input?.type === undefined ? {} : { type: input.type }),
            },
          },
          ...signalRequestArgs(input?.signal),
        ),
      );
    },
    async pathsExist(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"].paths.exist.$post(
          {
            param: { id: input.hostId },
            json: { paths: input.paths },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async openTargets(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"]["open-targets"].$get(
          { param: { id: input.hostId } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async open({ hostId, ...json }) {
      await transport.readVoid(
        transport.api.v1.hosts[":id"].open.$post({
          param: { id: hostId },
          json,
        }),
      );
    },
    async update(input) {
      return transport.readJson(
        transport.api.v1.hosts[":id"].$patch({
          param: { id: input.hostId },
          json: { name: input.name },
        }),
      );
    },
  };
}
