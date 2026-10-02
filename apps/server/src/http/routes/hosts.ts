import { randomUUID } from "node:crypto";
import { publicApiRoutes } from "@bb/server-contract";
import { z } from "zod";
import type { ServerContext } from "../../context.js";
import { newId } from "../../db/index.js";
import {
  destroyHost,
  findHost,
  insertHost,
  listHosts,
  updateHost,
} from "../../db/hosts.js";
import {
  hashToken,
  issueJoinToken,
  joinCommand,
  redeemJoinToken,
  type JoinToken,
} from "../../runners/enrollment.js";
import {
  hostResponse,
  publicServerUrl,
  requireHost,
} from "../../runners/hosts.js";
import { typedApi, type ApiApp } from "../api.js";
import { ApiError, invalidRequest } from "../errors.js";
import { principalOf } from "../trust.js";

interface RequestUrl {
  req: { url: string };
}

const MANUAL_MACHINE_PROVIDER_ID = "manual";

const joinBodySchema = z
  .object({ hostName: z.string().trim().min(1).max(100).optional() })
  .strict();

export function registerHostRoutes(app: ApiApp, ctx: ServerContext): void {
  const { del, get, patch, post } = typedApi(app);
  const routes = publicApiRoutes.hosts;
  const { db, hub, plugins, runners } = ctx;
  const pendingJoins = new Map<string, JoinToken>();

  const commandFor = async (
    c: RequestUrl,
    hostId: string,
    { joinToken, expiresAt }: JoinToken,
  ) => {
    const granting = plugins.machineAccess()?.grant(hostId);
    const access = await granting?.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new ApiError(502, "machine_access_unavailable", message);
    });
    const serverUrl =
      access?.serverUrl ?? publicServerUrl(ctx) ?? new URL(c.req.url).origin;
    const headers = access?.headers;
    const command = joinCommand({ serverUrl, hostId, joinToken, headers });
    return { command, expiresAt };
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
    const existing = findHost(db, "launch_key", launchKey);
    if (existing !== undefined) return c.json(hostResponse(ctx, existing), 201);
    const id = newId("host");
    insertHost(db, {
      id,
      name: `New machine ${id.slice(-6)}`,
      phase: "creating",
      statusMessage: "Waiting for the enrollment command to run",
      launchKey,
    });
    pendingJoins.set(id, issueJoinToken(db, id));
    hub.host(id, ["host-connected"]);
    return c.json(hostResponse(ctx, requireHost(ctx, id)), 201);
  });

  get(routes.list, (c, query) => {
    const includeCreating = query.includeCreating === "true";
    const hosts = listHosts(db, { includeCreating, type: query.type });
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
    if (principalOf(c).kind !== "owner") {
      throw new ApiError(
        403,
        "forbidden",
        "Machine credentials cannot read enrollment commands",
      );
    }
    const host = requireHost(ctx, c.req.param("id"));
    const pending = pendingJoins.get(host.id);
    const usable =
      pending !== undefined &&
      host.phase === "creating" &&
      host.joinTokenHash === hashToken(pending.joinToken) &&
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
    const token = issueJoinToken(db, host.id);
    const command = await commandFor(c, host.id, token);
    return c.json({ ...command, hostId: host.id }, 201);
  });

  patch(routes.update, (c, payload) => {
    const { id } = requireHost(ctx, c.req.param("id"));
    updateHost(db, id, { name: payload.name });
    hub.host(id, ["host-connected"]);
    return c.json(hostResponse(ctx, requireHost(ctx, id)));
  });

  patch(routes.updatePermissionCeiling, (c, payload) => {
    const { id } = requireHost(ctx, c.req.param("id"));
    updateHost(db, id, { maxPermissionMode: payload.maxPermissionMode });
    hub.host(id, ["host-connected"]);
    return c.json(hostResponse(ctx, requireHost(ctx, id)));
  });

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
    destroyHost(db, id);
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
}

export function registerRunnerRoutes(app: ApiApp, ctx: ServerContext): void {
  app.post("/runner/join", async (c) => {
    const raw: unknown = await c.req.json().catch(() => ({}));
    const body = joinBodySchema.safeParse(raw);
    if (!body.success) throw invalidRequest("Invalid runner join body");
    const credential = redeemJoinToken(ctx.db, {
      authorization: c.req.header("authorization"),
      principal: principalOf(c),
      hostName: body.data.hostName,
    });
    return c.json(credential);
  });
}
