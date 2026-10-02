import { randomUUID } from "node:crypto";
import type { Host } from "@bb/domain";
import { publicApiRoutes } from "@bb/server-contract";
import { z } from "zod";
import type { ServerContext, ServerRunner } from "../../context.js";
import { newId, type RowValues } from "../../db/index.js";
import * as store from "../../db/hosts.js";
import * as enrollment from "../../runners/enrollment.js";
import {
  hostResponse,
  publicServerUrl,
  requireHost,
} from "../../runners/hosts.js";
import { typedApi, type ApiApp } from "../api.js";
import { ApiError, errorMessage, invalidRequest } from "../errors.js";
import { principalOf, requireOwner } from "../trust.js";

interface HostRequest {
  req: { raw: Request; url: string; param(name: "id"): string };
}

const MANUAL_MACHINE_PROVIDER_ID = "manual";

const joinBodySchema = z
  .object({ hostName: z.string().trim().min(1).max(100).optional() })
  .strict();

export function registerHostRoutes(app: ApiApp, ctx: ServerContext): void {
  const { del, get, patch, post } = typedApi(app);
  const routes = publicApiRoutes.hosts;
  const { db, hub, plugins, runners } = ctx;
  const pendingJoins = new Map<string, enrollment.JoinToken>();

  const commandFor = async (
    c: HostRequest,
    hostId: string,
    { joinToken, expiresAt }: enrollment.JoinToken,
  ) => {
    const granting = plugins.machineAccess()?.grant(hostId);
    const access = await granting?.catch((error: unknown) => {
      const code = "machine_access_unavailable";
      throw new ApiError(502, code, errorMessage(error));
    });
    const serverUrl =
      access?.serverUrl ?? publicServerUrl(ctx) ?? new URL(c.req.url).origin;
    const headers = access?.headers;
    const command = enrollment.joinCommand({
      serverUrl,
      hostId,
      joinToken,
      headers,
    });
    return { command, expiresAt };
  };

  const patchHost = (hostId: string, patch: RowValues): Host => {
    const { id } = requireHost(ctx, hostId);
    store.updateHost(db, id, patch);
    hub.host(id, ["host-connected"]);
    return hostResponse(ctx, requireHost(ctx, id));
  };

  const ownerRunner = (c: HostRequest): ServerRunner => {
    requireOwner(c, "Only the owner can open paths in local apps");
    return runners.get(requireHost(ctx, c.req.param("id")).id);
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
    if (existing !== undefined) return c.json(hostResponse(ctx, existing), 201);
    const id = newId("host");
    store.insertHost(db, {
      id,
      name: `New machine ${id.slice(-6)}`,
      phase: "creating",
      statusMessage: "Waiting for the enrollment command to run",
      launchKey,
    });
    pendingJoins.set(id, enrollment.issueJoinToken(db, id));
    hub.host(id, ["host-connected"]);
    return c.json(hostResponse(ctx, requireHost(ctx, id)), 201);
  });

  get(routes.list, (c, query) => {
    const includeCreating = query.includeCreating === "true";
    const hosts = store.listHosts(db, { includeCreating, type: query.type });
    return c.json(hosts.map((host) => hostResponse(ctx, host)));
  });

  get(routes.get, (c) => {
    const host = requireHost(ctx, c.req.param("id"));
    return c.json({
      ...hostResponse(ctx, host),
      connectMachineId: host.connectMachineId,
      threadStorageRootPath: host.threadStorageRoot,
    });
  });

  get(routes.enrollmentCommand, async (c) => {
    requireOwner(c, "Machine credentials cannot read enrollment commands");
    const host = requireHost(ctx, c.req.param("id"));
    const pending = pendingJoins.get(host.id);
    const usable =
      pending !== undefined &&
      host.phase === "creating" &&
      host.joinTokenHash === enrollment.hashToken(pending.joinToken) &&
      pending.expiresAt > ctx.now();
    return c.json(usable ? await commandFor(c, host.id, pending) : null);
  });

  post(routes.reconnect, async (c) => {
    const host = requireHost(ctx, c.req.param("id"));
    if (host.id === ctx.config.hostId || host.phase !== "active") {
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

  patch(routes.update, (c, { name }) =>
    c.json(patchHost(c.req.param("id"), { name })),
  );

  patch(routes.updatePermissionCeiling, (c, { maxPermissionMode }) =>
    c.json(patchHost(c.req.param("id"), { maxPermissionMode })),
  );

  del(routes.delete, async (c) => {
    const { id, connectMachineId } = requireHost(ctx, c.req.param("id"));
    if (id === ctx.config.hostId) {
      throw new ApiError(
        400,
        "primary_host_removal_refused",
        "The server's own machine cannot be removed",
      );
    }
    const wasConnected = runners.isConnected(id);
    store.destroyHost(db, id);
    pendingJoins.delete(id);
    runners.disconnect(id);
    if (!wasConnected) hub.host(id, ["host-disconnected"]);
    const revoking = plugins.machineAccess()?.revoke({ id, connectMachineId });
    await revoking?.catch((error: unknown) => {
      ctx.log.warn("Machine access was not revoked", {
        hostId: id,
        err: error,
      });
    });
    return c.json({ ok: true });
  });

  get(routes.openTargets, async (c) =>
    c.json(await ownerRunner(c).listOpenTargets()),
  );

  post(routes.open, async (c, { line = null, column = null, ...target }) => {
    await ownerRunner(c).openInTarget({ ...target, line, column });
    return c.json({ ok: true });
  });
}

export function registerRunnerRoutes(app: ApiApp, ctx: ServerContext): void {
  app.post("/runner/join", async (c) => {
    const raw: unknown = await c.req.json().catch(() => ({}));
    const body = joinBodySchema.safeParse(raw);
    if (!body.success) throw invalidRequest("Invalid runner join body");
    const credential = enrollment.redeemJoinToken(ctx.db, {
      authorization: c.req.header("authorization"),
      principal: principalOf(c),
      hostName: body.data.hostName,
    });
    return c.json(credential);
  });
}
