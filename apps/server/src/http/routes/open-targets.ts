import { publicApiRoutes } from "@bb/server-contract";
import type { ServerContext, ServerRunner } from "../../context.js";
import { requireHost } from "../../runners/hosts.js";
import { typedApi, type ApiApp } from "../api.js";
import { ApiError } from "../errors.js";
import { principalOf } from "../trust.js";

interface HostRequest {
  req: { raw: Request; param(name: "id"): string };
}

export function registerOpenTargetRoutes(
  app: ApiApp,
  ctx: ServerContext,
): void {
  const { get, post } = typedApi(app);
  const routes = publicApiRoutes.hosts;

  const ownerRunner = (c: HostRequest): ServerRunner => {
    if (principalOf(c).kind !== "owner") {
      const message = "Only the owner can open paths in local apps";
      throw new ApiError(403, "forbidden", message);
    }
    return ctx.runners.get(requireHost(ctx, c.req.param("id")).id);
  };

  get(routes.openTargets, async (c) =>
    c.json(await ownerRunner(c).listOpenTargets()),
  );

  post(routes.open, async (c, { line = null, column = null, ...target }) => {
    await ownerRunner(c).openInTarget({ ...target, line, column });
    return c.json({ ok: true });
  });
}
