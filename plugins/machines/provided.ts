import type { JsonValue } from "@bb/domain";
import { machines, type PluginServerApi } from "@bb/plugin";
import { actorUserId } from "@bb/server-kit/auth/actor";
import { loopbackUrl } from "@bb/server-kit/config";
import { newId } from "@bb/server-kit/db/index";
import * as store from "@bb/server-kit/db/hosts";
import { ApiError, errorMessage } from "@bb/server-kit/http/errors";
import * as enrollment from "@bb/server-kit/runners/enrollment";
import { publicServerUrl, requireHost } from "@bb/server-kit/runners/hosts";

function resourceOf(row: store.HostRow): JsonValue | null {
  return row.resource === null ? null : (JSON.parse(row.resource) as JsonValue);
}

export async function destroyMachine(
  bb: PluginServerApi,
  host: store.HostRow,
): Promise<void> {
  const { db, realtime: hub, runners, log } = bb;
  const { id, connectMachineId } = host;
  const wasConnected = runners.isConnected(id);
  store.destroyHost(db, id);
  runners.disconnect(id);
  if (!wasConnected) hub.host(id, ["host-disconnected"]);
  const revoking = bb.pick(machines.access)?.revoke({ id, connectMachineId });
  await revoking?.catch((error: unknown) => {
    log.warn("Machine access was not revoked", { hostId: id, err: error });
  });
  bb.emit(machines.deleted, { hostId: id });
}

export function providerOf(bb: PluginServerApi, host: store.HostRow) {
  const id = host.machineProviderId;
  const provider = id === null ? null : bb.find(machines.provider, id);
  return { provider, machine: { hostId: host.id, resource: resourceOf(host) } };
}

export function provideMachines(bb: PluginServerApi): void {
  const { db, realtime: hub, runners } = bb;

  bb.implement(machines.enroll, async ({ name, providerId, resource }) => {
    const id = newId("host");
    store.insertHost(db, {
      id,
      name,
      phase: "creating",
      statusMessage: "Waiting for the machine to connect",
      ownerUserId: actorUserId(),
      machineProviderId: providerId ?? null,
      resource: resource === undefined ? null : JSON.stringify(resource),
    });
    const { joinToken, expiresAt } = enrollment.issueJoinToken(db, id);
    const access = await bb.pick(machines.access)?.grant(id);
    const serverUrl =
      access?.serverUrl ?? publicServerUrl(bb) ?? loopbackUrl(bb.server);
    const headers = access?.headers;
    const blob = { serverUrl, hostId: id, joinToken, headers };
    hub.host(id, ["host-connected"]);
    const command = enrollment.joinCommand(blob);
    return { hostId: id, command, serverUrl, expiresAt };
  });

  bb.implement(machines.waitConnected, ({ hostId, timeoutMs }) => {
    if (runners.isConnected(hostId)) return true;
    return new Promise<boolean>((resolve) => {
      const settle = (connected: boolean) => {
        stop();
        clearTimeout(timer);
        resolve(connected);
      };
      const stop = runners.onConnected((id) => {
        if (id === hostId) settle(true);
      });
      const timer = setTimeout(settle, timeoutMs, false);
    });
  });

  bb.implement(machines.update, ({ hostId, name, resource }) => {
    requireHost(bb, hostId);
    const renamed = name === undefined ? {} : { name };
    const kept =
      resource === undefined ? {} : { resource: JSON.stringify(resource) };
    store.updateHost(db, hostId, { ...renamed, ...kept });
    hub.host(hostId, ["host-connected"]);
  });

  const lifecycle = async (hostId: string, step: "suspend" | "resume") => {
    const host = requireHost(bb, hostId);
    const { provider, machine } = providerOf(bb, host);
    const run = provider?.[step];
    if (run === undefined) {
      const message = `This machine's provider cannot ${step} it`;
      throw new ApiError(409, "machine_lifecycle_unsupported", message);
    }
    try {
      await run(machine);
    } catch (error) {
      const message = `Could not ${step} the machine: ${errorMessage(error)}`;
      throw new ApiError(502, "machine_provider_failed", message);
    }
    const suspendedAt = step === "suspend" ? bb.now() : null;
    store.updateHost(db, hostId, { suspendedAt });
    hub.host(hostId, ["host-connected"]);
  };
  bb.implement(machines.suspend, ({ hostId }) => lifecycle(hostId, "suspend"));
  bb.implement(machines.resume, ({ hostId }) => lifecycle(hostId, "resume"));

  bb.implement(machines.delete, async ({ hostId }) => {
    if (hostId === bb.server.hostId) {
      const message = "The server's own machine cannot be removed";
      throw new ApiError(400, "primary_host_removal_refused", message);
    }
    await destroyMachine(bb, requireHost(bb, hostId));
  });

  bb.onDispose(
    runners.onConnected((hostId) => bb.emit(machines.connected, { hostId })),
  );
  bb.onDispose(
    runners.onEvent("plugin.signal", ({ pluginId, name, payload }, hostId) =>
      bb.emit(machines.signaled, { hostId, pluginId, name, payload }),
    ),
  );
  bb.onDispose(
    runners.onDisconnected((hostId) =>
      bb.emit(machines.disconnected, { hostId }),
    ),
  );
}
