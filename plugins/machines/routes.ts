import { machines } from "@bb/plugin";
import type { PluginServerApi } from "@bb/plugin";
import { randomUUID } from "node:crypto";
import type { Host } from "@bb/domain";
import { publicApiRoutes } from "@bb/server-contract";
import { z } from "zod";
import { actorUserId, currentActor } from "@bb/server-kit/auth/actor";
import { newId, type RowValues } from "@bb/server-kit/db/index";
import * as store from "@bb/server-kit/db/hosts";
import { canManageHost } from "@bb/server-kit/runners/access";
import * as enrollment from "@bb/server-kit/runners/enrollment";
import {
  hostResponse,
  publicServerUrl,
  requireHost,
} from "@bb/server-kit/runners/hosts";
import { typedApi, type ApiApp } from "@bb/server-kit/http/api";
import {
  ApiError,
  errorMessage,
  forbidden,
  invalidRequest,
} from "@bb/server-kit/http/errors";
import { principalOf, requireUser } from "@bb/server-kit/http/trust";
import { destroyMachine, providerOf } from "./provided.js";

interface HostRequest {
  req: { raw: Request; url: string; param(name: "id"): string };
}

const MANUAL_MACHINE_PROVIDER_ID = "manual";

const joinBodySchema = z
  .object({ hostName: z.string().trim().min(1).max(100).optional() })
  .strict();

export function registerHostRoutes(app: ApiApp, bb: PluginServerApi): void {
  const { del, get, patch, post } = typedApi(app);
  const routes = publicApiRoutes.hosts;
  const { db, realtime: hub, runners } = bb;
  const pendingJoins = new Map<string, enrollment.JoinToken>();

  const commandFor = async (
    c: HostRequest,
    hostId: string,
    { joinToken, expiresAt }: enrollment.JoinToken,
  ) => {
    const granting = bb.pick(machines.access)?.grant(hostId);
    const access = await granting?.catch((error: unknown) => {
      const code = "machine_access_unavailable";
      throw new ApiError(502, code, errorMessage(error));
    });
    const serverUrl =
      access?.serverUrl ?? publicServerUrl(bb) ?? new URL(c.req.url).origin;
    const headers = access?.headers;
    const command = enrollment.joinCommand({
      serverUrl,
      hostId,
      joinToken,
      headers,
    });
    return { command, expiresAt };
  };

  const managedHost = (c: HostRequest) => {
    requireUser(c);
    const host = requireHost(bb, c.req.param("id"));
    if (canManageHost(host, currentActor())) return host;
    throw forbidden("Only this machine's owner can manage it");
  };

  const patchHost = (c: HostRequest, patch: RowValues): Host => {
    const { id } = managedHost(c);
    store.updateHost(db, id, patch);
    hub.host(id, ["host-connected"]);
    return hostResponse(bb, requireHost(bb, id));
  };

  const userRunner = (c: HostRequest) => {
    requireUser(c);
    return runners.get(requireHost(bb, c.req.param("id")).id);
  };

  post(routes.create, (c, payload) => {
    if (payload.machineProviderId !== MANUAL_MACHINE_PROVIDER_ID) {
      throw new ApiError(
        404,
        "machine_provider_not_found",
        `Unknown machine provider '${payload.machineProviderId}'. Only ` +
          `'${MANUAL_MACHINE_PROVIDER_ID}' machines can be added.`,
      );
    }
    const launchKey = payload.key ?? randomUUID();
    const existing = store.findHost(db, "launch_key", launchKey);
    if (existing !== undefined) return c.json(hostResponse(bb, existing), 201);
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
    hub.host(id, ["host-connected"]);
    return c.json(hostResponse(bb, requireHost(bb, id)), 201);
  });

  get(routes.list, (c, query) => {
    const includeCreating = query.includeCreating === "true";
    const hosts = store.listHosts(db, { includeCreating, type: query.type });
    return c.json(hosts.map((host) => hostResponse(bb, host)));
  });

  get(routes.get, (c) => {
    const host = requireHost(bb, c.req.param("id"));
    return c.json({
      ...hostResponse(bb, host),
      connectMachineId: host.connectMachineId,
      threadStorageRootPath: host.threadStorageRoot,
    });
  });

  get(routes.enrollmentCommand, async (c) => {
    const host = managedHost(c);
    const pending = pendingJoins.get(host.id);
    const usable =
      pending !== undefined &&
      host.phase === "creating" &&
      host.joinTokenHash === enrollment.hashToken(pending.joinToken) &&
      pending.expiresAt > bb.now();
    return c.json(usable ? await commandFor(c, host.id, pending) : null);
  });

  post(routes.reconnect, async (c) => {
    const host = managedHost(c);
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
    const command = await commandFor(c, host.id, token);
    return c.json({ ...command, hostId: host.id }, 201);
  });

  patch(routes.update, (c, { name }) => c.json(patchHost(c, { name })));

  patch(routes.updateSharing, (c, { sharing }) =>
    c.json(patchHost(c, { sharing })),
  );

  patch(routes.updatePermissionCeiling, (c, { maxPermissionMode }) =>
    c.json(patchHost(c, { maxPermissionMode })),
  );

  del(routes.delete, async (c) => {
    const { id } = managedHost(c);
    if (id === bb.server.hostId) {
      throw new ApiError(
        400,
        "primary_host_removal_refused",
        "The server's own machine cannot be removed",
      );
    }
    const host = requireHost(bb, id);
    const { provider, machine } = providerOf(bb, host);
    await Promise.resolve(provider?.remove?.(machine)).catch(
      (error: unknown) => {
        const message = `The machine's provider could not remove it: ${errorMessage(error)}`;
        throw new ApiError(502, "machine_provider_failed", message);
      },
    );
    pendingJoins.delete(id);
    await destroyMachine(bb, host);
    return c.json({ ok: true });
  });

  get(routes.openTargets, async (c) =>
    c.json(await userRunner(c).listOpenTargets()),
  );

  post(routes.open, async (c, { line = null, column = null, ...target }) => {
    await userRunner(c).openInTarget({ ...target, line, column });
    return c.json({ ok: true });
  });
}

export function registerRunnerRoutes(app: ApiApp, bb: PluginServerApi): void {
  app.post("/runner/join", async (c) => {
    const raw: unknown = await c.req.json().catch(() => ({}));
    const body = joinBodySchema.safeParse(raw);
    if (!body.success) throw invalidRequest("Invalid runner join body");
    const credential = enrollment.redeemJoinToken(bb.db, {
      authorization: c.req.header("authorization"),
      principal: principalOf(c),
      hostName: body.data.hostName,
    });
    return c.json(credential);
  });
}
