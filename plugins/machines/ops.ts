import { workspaces } from "@bb/runner";
import { machines, type Caller, type PluginServerApi } from "@bb/plugin";
import { randomUUID } from "node:crypto";
import { actorUserId, currentActor } from "@bb/server-kit/auth/actor";
import { loopbackUrl } from "@bb/server-kit/config";
import { newId } from "@bb/server-kit/db/index";
import * as store from "@bb/server-kit/db/hosts";
import { canManageHost } from "@bb/server-kit/runners/access";
import * as enrollment from "@bb/server-kit/runners/enrollment";
import {
  hostResponse,
  publicServerUrl,
  requireHost,
} from "@bb/server-kit/runners/hosts";
import { ApiError, errorMessage, forbidden } from "@bb/server-kit/http/errors";
import { requestOrigin, requireUser } from "@bb/server-kit/http/trust";
import { destroyMachine, providerOf } from "./provided.js";

const MANUAL_MACHINE_PROVIDER_ID = "manual";

export function implementMachines(bb: PluginServerApi): void {
  const { db, realtime: hub, runners } = bb;
  const pendingJoins = new Map<string, enrollment.JoinToken>();

  const commandFor = async (
    hostId: string,
    { joinToken, expiresAt }: enrollment.JoinToken,
  ) => {
    const granting = bb.pick(machines.access)?.grant(hostId);
    const access = await granting?.catch((error: unknown) => {
      const code = "machine_access_unavailable";
      throw new ApiError(502, code, errorMessage(error));
    });
    const origin = requestOrigin() ?? loopbackUrl(bb.server);
    const serverUrl = access?.serverUrl ?? publicServerUrl(bb) ?? origin;
    const headers = access?.headers;
    const command = enrollment.joinCommand({
      serverUrl,
      hostId,
      joinToken,
      headers,
    });
    return { command, expiresAt };
  };

  const managedHost = (hostId: string, caller: Caller) => {
    if (caller.via.length > 0) return requireHost(bb, hostId);
    requireUser();
    const host = requireHost(bb, hostId);
    if (canManageHost(host, currentActor())) return host;
    throw forbidden("Only this machine's owner can manage it");
  };

  const changed = (hostId: string) => {
    hub.host(hostId, ["host-connected"]);
    return hostResponse(bb, requireHost(bb, hostId));
  };

  const userRunner = (hostId: string) => {
    requireUser();
    return runners.get(requireHost(bb, hostId).id);
  };

  bb.implement(machines.create, (request) => {
    if (request.machineProviderId !== MANUAL_MACHINE_PROVIDER_ID) {
      throw new ApiError(
        404,
        "machine_provider_not_found",
        `Unknown machine provider '${request.machineProviderId}'. Only ` +
          `'${MANUAL_MACHINE_PROVIDER_ID}' machines can be added.`,
      );
    }
    const launchKey = request.key ?? randomUUID();
    const existing = store.findHost(db, "launch_key", launchKey);
    if (existing !== undefined) return hostResponse(bb, existing);
    const id = newId("host");
    store.insertHost(db, {
      id,
      name: `New machine ${id.slice(-6)}`,
      phase: "creating",
      statusMessage: "Waiting for the enrollment command to run",
      launchKey,
      ownerUserId: actorUserId(),
    });
    pendingJoins.set(id, enrollment.issueJoinToken(db, id));
    return changed(id);
  });

  bb.implement(machines.list, ({ includeCreating = false, type }) =>
    store
      .listHosts(db, { includeCreating, type })
      .map((host) => hostResponse(bb, host)),
  );

  bb.implement(machines.get, ({ hostId }) => {
    const host = requireHost(bb, hostId);
    return {
      ...hostResponse(bb, host),
      connectMachineId: host.connectMachineId,
      threadStorageRootPath: host.threadStorageRoot,
    };
  });

  bb.implement(machines.enrollmentCommand, async ({ hostId }, { caller }) => {
    const host = managedHost(hostId, caller);
    const pending = pendingJoins.get(host.id);
    const usable =
      pending !== undefined &&
      host.phase === "creating" &&
      host.joinTokenHash === enrollment.hashToken(pending.joinToken) &&
      pending.expiresAt > bb.now();
    return usable ? await commandFor(host.id, pending) : null;
  });

  bb.implement(
    machines.createReconnectCommand,
    async ({ hostId }, { caller }) => {
      const host = managedHost(hostId, caller);
      if (host.id === bb.server.hostId || host.phase !== "active") {
        throw new ApiError(
          409,
          "machine_reconnect_unavailable",
          "Only active machines other than the server's own can be reconnected",
        );
      }
      if (runners.isConnected(host.id)) {
        throw new ApiError(
          409,
          "machine_reconnect_not_needed",
          "Machine is connected and doesn't need reconnecting",
        );
      }
      const token = enrollment.issueJoinToken(db, host.id);
      const command = await commandFor(host.id, token);
      return { ...command, hostId: host.id };
    },
  );

  bb.implement(machines.update, ({ hostId, name, resource }, { caller }) => {
    const { id } = managedHost(hostId, caller);
    if (resource !== undefined && caller.via.length === 0) {
      throw forbidden("Only a plugin can record a machine's resource");
    }
    const renamed = name === undefined ? {} : { name };
    const kept =
      resource === undefined ? {} : { resource: JSON.stringify(resource) };
    store.updateHost(db, id, { ...renamed, ...kept });
    return changed(id);
  });

  bb.implement(machines.updateSharing, ({ hostId, sharing }, { caller }) => {
    const { id } = managedHost(hostId, caller);
    store.updateHost(db, id, { sharing });
    return changed(id);
  });

  bb.implement(
    machines.updatePermissionCeiling,
    ({ hostId, maxPermissionMode }, { caller }) => {
      const { id } = managedHost(hostId, caller);
      store.updateHost(db, id, { maxPermissionMode });
      return changed(id);
    },
  );

  bb.implement(machines.delete, async ({ hostId }, { caller }) => {
    const host = managedHost(hostId, caller);
    if (host.id === bb.server.hostId) {
      const message = "The server's own machine cannot be removed";
      throw new ApiError(400, "primary_host_removal_refused", message);
    }
    if (caller.via.length === 0) {
      const { provider, machine } = providerOf(bb, host);
      await Promise.resolve(provider?.delete?.(machine)).catch(
        (error: unknown) => {
          const message = `The machine's provider could not remove it: ${errorMessage(error)}`;
          throw new ApiError(502, "machine_provider_failed", message);
        },
      );
    }
    pendingJoins.delete(host.id);
    await destroyMachine(bb, host);
  });

  bb.implement(machines.openTargets, ({ hostId }) =>
    userRunner(hostId).call(workspaces.openTargets, {}),
  );

  bb.implement(
    machines.open,
    async ({ hostId, line = null, column = null, ...target }) => {
      await userRunner(hostId).call(workspaces.openIn, {
        ...target,
        line,
        column,
      });
    },
  );
}
