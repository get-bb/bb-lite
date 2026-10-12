import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { dashboardOf, linkViewOf, viewerOf } from "../src/dashboard.js";
import type { ConsentView, LinkView } from "../src/dashboard-types.js";
import { consentOf } from "../src/oauth.js";
import * as site from "../src/site.js";

export type LinkState =
  | { signedIn: false }
  | { signedIn: true; view: LinkView }
  | { signedIn: true; problem: string };

export type ConsentState =
  | { signedIn: false; query: string }
  | { signedIn: true; query: string; consent: ConsentView }
  | { signedIn: true; query: string; problem: string };

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

export const loadConsent = createServerFn({ method: "GET" })
  .validator((browserQuery: string | null) => browserQuery)
  .handler(async ({ data: browserQuery }): Promise<ConsentState> => {
    const { context, user } = await visitor();
    const query = browserQuery ?? new URL(getRequest().url).search;
    if (user === null) return { signedIn: false, query };
    const params = new URLSearchParams(query);
    const consent = await consentOf(context, user, params);
    if ("problem" in consent) {
      return { signedIn: true, query, problem: consent.problem };
    }
    return { signedIn: true, query, consent };
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
