import type { PluginServerApi } from "@bb/plugin";
import { z } from "zod";
import * as enrollment from "@bb/server-kit/runners/enrollment";
import type { ApiApp } from "@bb/server-kit/http/api";
import { invalidRequest } from "@bb/server-kit/http/errors";
import { principalOf } from "@bb/server-kit/http/trust";

const joinBodySchema = z
  .object({ hostName: z.string().trim().min(1).max(100).optional() })
  .strict();

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
