import { z } from "zod";

const REQUEST_TIMEOUT_MS = 15_000;
export const MACHINE_HEADER = "x-bb-connect-machine";

const POLL_REFUSALS: Record<number, string> = {
  403: "Sign-in was denied on getbb.dev.",
  404: "getbb.dev no longer knows this sign-in.",
  409: "This sign-in was already completed.",
  410: "The sign-in code expired.",
};
const REDEEM_REFUSALS: Record<number, string> = {
  400: "That code is invalid; get a new one from the getbb.dev dashboard.",
  404: "That code is invalid; get a new one from the getbb.dev dashboard.",
  409: "That code was already used; get a new one from the getbb.dev dashboard.",
  410: "That code has expired; get a new one from the getbb.dev dashboard.",
};
const MACHINE_LIMIT =
  "this account has reached its machine limit; revoke a device on the " +
  "getbb.dev dashboard, then try again";

const profileSchema = z.object({
  serverId: z.string().min(1),
  serverLabel: z.string().min(1),
  serverUrl: z.url(),
});
const linkStartSchema = z.object({
  deviceCode: z.string().min(1),
  userCode: z.string().min(1),
  verificationUrl: z.url(),
  expiresAt: z.number(),
  intervalMs: z.number().int().positive(),
});
const linkPollSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({
    status: z.literal("approved"),
    credential: z.string().min(1),
    serverId: z.string().min(1),
  }),
]);
const redeemSchema = z.object({ credential: z.string().min(1) });
const machineCodeSchema = z.object({ code: z.string().min(1) });
const machineSchema = z.object({
  credential: z.string().min(1),
  machineId: z.string().min(1),
});

export type LinkStart = z.infer<typeof linkStartSchema>;
export type LinkPoll =
  | z.infer<typeof linkPollSchema>
  | { status: "slow-down" }
  | { status: "refused"; message: string };

export type RedeemResult =
  | { status: "redeemed"; credential: string }
  | { status: "refused"; message: string };

interface HostedCall {
  method?: "GET";
  credential?: string;
  body?: unknown;
  send?: typeof fetch;
}

async function call(origin: string, path: string, request: HostedCall = {}) {
  const { method = "POST", credential, body, send = fetch } = request;
  const url = new URL(path, origin);
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (credential !== undefined) {
    headers.authorization = `Bearer ${credential}`;
    headers[MACHINE_HEADER] = credential;
  }
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const init = { method, headers, redirect: "manual", signal } as const;
  const sent = body === undefined ? undefined : JSON.stringify(body);
  const response = await send(url, { ...init, body: sent }).catch(
    (error: unknown) => {
      throw new Error(`couldn't reach ${url.host}: ${String(error)}`);
    },
  );
  const { status } = response;
  const json: unknown = await response.json().catch(() => null);
  const read = <Schema extends z.ZodType>(schema: Schema, what: string) => {
    const parsed = schema.safeParse(json);
    if (status >= 200 && status < 300 && parsed.success) return parsed.data;
    throw new Error(`${url.host} returned HTTP ${status} ${what}`);
  };
  return { status, read };
}

export async function fetchProfile(
  origin: string,
  credential: string,
  send?: typeof fetch,
) {
  const request = { method: "GET", credential, send } as const;
  const reply = await call(origin, "/api/account/me", request);
  if (reply.status === 401) return "unauthorized";
  return reply.read(profileSchema, "for the account profile");
}

export async function startLink(
  origin: string,
  clientName: string,
  send?: typeof fetch,
) {
  const body = { clientName };
  const reply = await call(origin, "/api/account/link/start", { body, send });
  const started = reply.read(linkStartSchema, "when starting sign-in");
  if (new URL(started.verificationUrl).origin !== new URL(origin).origin) {
    throw new Error("the sign-in link points at a different site");
  }
  return started;
}

export async function redeemCode(
  origin: string,
  code: string,
  send?: typeof fetch,
): Promise<RedeemResult> {
  const request = { body: { code }, send };
  const reply = await call(origin, "/api/connect/redeem", request);
  const refused = REDEEM_REFUSALS[reply.status];
  if (refused !== undefined) return { status: "refused", message: refused };
  const { credential } = reply.read(redeemSchema, "when redeeming the code");
  return { status: "redeemed", credential };
}

export async function pollLink(
  origin: string,
  deviceCode: string,
  send?: typeof fetch,
): Promise<LinkPoll> {
  const body = { deviceCode };
  const reply = await call(origin, "/api/account/link/poll", { body, send });
  if (reply.status === 429) return { status: "slow-down" };
  const message = POLL_REFUSALS[reply.status];
  if (message !== undefined) return { status: "refused", message };
  return reply.read(linkPollSchema, "while waiting for approval");
}

export async function disconnectServer(serverUrl: string, credential: string) {
  const path = "/api/connect/disconnect";
  const reply = await call(serverUrl, path, { credential });
  if (reply.status === 401 || reply.status === 403) return;
  reply.read(z.unknown(), "when signing out");
}

export async function reportActivity(origin: string, credential: string) {
  const reply = await call(origin, "/api/connect/activity", { credential });
  reply.read(z.unknown(), "when reporting activity");
}

export async function mintMachine(origin: string, credential: string) {
  const minting = "/api/connect/machine-code";
  const minted = await call(origin, minting, { credential });
  if (minted.status === 409) throw new Error(MACHINE_LIMIT);
  const body = minted.read(machineCodeSchema, "when minting a machine code");
  const redeemed = await call(origin, "/api/connect/redeem-machine", { body });
  return redeemed.read(machineSchema, "when redeeming a machine code");
}

export async function revokeMachine(
  origin: string,
  credential: string,
  machineId: string,
): Promise<void> {
  const request = { credential, body: { machineId } };
  const reply = await call(origin, "/api/connect/revoke-machine", request);
  reply.read(z.object({ ok: z.literal(true) }), "when revoking a machine");
}
