import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { dashboardOf, linkViewOf, viewerOf } from "../src/dashboard.js";
import type { LinkView } from "../src/dashboard-types.js";
import * as site from "../src/site.js";

export type LinkState =
  | { signedIn: false }
  | { signedIn: true; view: LinkView }
  | { signedIn: true; problem: string };

async function visitor() {
  const request = getRequest();
  const context = site.siteOf(request, env as unknown as site.Env);
  const user = await site.accountHolder(request, context);
  return { context, user };
}

export const loadLogin = createServerFn({ method: "GET" }).handler(async () => {
  const { context, user } = await visitor();
  const viewer = user === null ? null : viewerOf(context, user);
  return { viewer, baseHost: context.baseHost };
});

export const loadDashboard = createServerFn({ method: "GET" }).handler(
  async () => {
    const { context, user } = await visitor();
    return user === null ? null : dashboardOf(context, user);
  },
);

export const loadLink = createServerFn({ method: "GET" })
  .validator((code: string) => code)
  .handler(async ({ data: code }): Promise<LinkState> => {
    const { context, user } = await visitor();
    if (user === null) return { signedIn: false };
    const view = await linkViewOf(context, user, code);
    if ("error" in view) return { signedIn: true, problem: view.message };
    return { signedIn: true, view };
  });

export async function post<Reply = { ok: true }>(
  path: string,
  body: unknown = {},
): Promise<Reply> {
  const response = await fetch(`/api/dashboard${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const reply: unknown = await response.json().catch(() => null);
  if (response.ok) return reply as Reply;
  const message =
    reply !== null && typeof reply === "object" && "message" in reply
      ? String(reply.message)
      : "Something went wrong. Try again.";
  throw new Error(message);
}
