import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type {
  Account,
  LoginPoll,
  LoginStart,
  PoolConfig,
  PoolProvider,
} from "./contract.js";
import { dig, epochMs, retryAfterMs } from "./limits.js";
import type { NewAccount, OAuthSecret } from "./store.js";

export const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const CLAUDE_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const CLAUDE_SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CHATGPT_AUTH_CLAIM = "https://api.openai.com/auth";
const CHATGPT_PROFILE_CLAIM = "https://api.openai.com/profile";
const LOGIN_TTL_MS = 10 * 60 * 1_000;
const REFRESH_TIMEOUT_MS = 15_000;
const JSON_HEADERS = {
  accept: "application/json",
  "content-type": "application/json",
};

export type AccountDraft = Omit<NewAccount, "kind" | "enabled" | "priority"> & {
  secret: OAuthSecret;
};

export class TransientRefreshError extends Error {
  constructor(
    reason: string,
    readonly retryAfterMs = 0,
  ) {
    super(`OAuth refresh ${reason}.`);
  }
}

function text(value: unknown, ...keys: string[]): string | null {
  const found = dig(value, ...keys);
  return typeof found === "string" && found.trim() !== "" ? found.trim() : null;
}

function email(value: unknown, ...keys: string[]): string | null {
  return z.email().safeParse(text(value, ...keys)).data ?? null;
}

function positive(value: unknown, key: string): number | null {
  const found = dig(value, key);
  return typeof found === "number" && found > 0 ? found : null;
}

function jwtClaims(token: string | null): unknown {
  try {
    const payload = Buffer.from(token?.split(".")[1] ?? "", "base64url");
    return JSON.parse(payload.toString("utf8"));
  } catch {
    return null;
  }
}

function jwtExpiry(token: string): number | null {
  const expiry = positive(jwtClaims(token), "exp");
  return expiry === null ? null : Math.round(expiry * 1_000);
}

function codexDraft(
  accessToken: string,
  refreshToken: string,
  idToken: string | null,
  accountId: string | null = null,
): AccountDraft {
  const [id, access] = [jwtClaims(idToken), jwtClaims(accessToken)];
  const account = [CHATGPT_AUTH_CLAIM, "chatgpt_account_id"];
  const codexAccountId =
    accountId ??
    text(id, ...account) ??
    text(id, "chatgpt_account_id") ??
    text(access, ...account);
  if (codexAccountId === null) {
    throw new Error("Codex tokens do not include a ChatGPT account id.");
  }
  const address =
    email(id, "email") ??
    email(id, CHATGPT_PROFILE_CLAIM, "email") ??
    email(access, "email") ??
    email(access, CHATGPT_PROFILE_CLAIM, "email");
  const expiresAt = jwtExpiry(accessToken);
  const tokens = { accessToken, refreshToken, expiresAt };
  return {
    provider: "codex",
    label: address ?? "Codex account",
    email: address,
    accountUuid: null,
    codexAccountId,
    subscriptionType: null,
    rateLimitTier: null,
    secret: { kind: "oauth", ...tokens, ...(idToken ? { idToken } : {}) },
  };
}

async function homeJson(...segments: string[]): Promise<unknown> {
  try {
    const file = path.join(os.homedir(), ...segments);
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

export async function importAccount(
  provider: PoolProvider,
): Promise<AccountDraft> {
  const codex = provider === "codex";
  const file = codex
    ? [".codex", "auth.json"]
    : [".claude", ".credentials.json"];
  const tokens = dig(
    await homeJson(...file),
    codex ? "tokens" : "claudeAiOauth",
  );
  const accessToken = text(tokens, codex ? "access_token" : "accessToken");
  const refreshToken = text(tokens, codex ? "refresh_token" : "refreshToken");
  if (accessToken === null || refreshToken === null) {
    const [name, command] = codex
      ? ["Codex", "codex login"]
      : ["Claude Code", "claude /login"];
    const advice = `Run \`${command}\` on the bb server host, then retry.`;
    throw new Error(`${name} OAuth credentials were not found. ${advice}`);
  }
  if (codex) {
    const idToken = text(tokens, "id_token");
    const accountId = text(tokens, "account_id");
    return codexDraft(accessToken, refreshToken, idToken, accountId);
  }
  const owner = dig(await homeJson(".claude.json"), "oauthAccount");
  const address = email(owner, "emailAddress");
  const expiry = positive(tokens, "expiresAt");
  const expiresAt = expiry === null ? null : Math.round(expiry);
  return {
    provider: "claude",
    label: address ?? "Claude Code account",
    email: address,
    accountUuid: z.uuid().safeParse(dig(owner, "accountUuid")).data ?? null,
    subscriptionType: text(tokens, "subscriptionType"),
    rateLimitTier: text(tokens, "rateLimitTier"),
    secret: { kind: "oauth", accessToken, refreshToken, expiresAt },
  };
}

function codexAuthUrl(config: PoolConfig, pathname: string): string {
  return `${config.codexAuthBaseUrl.replace(/\/+$/u, "")}${pathname}`;
}

export async function refreshOAuth(
  provider: PoolProvider,
  secret: OAuthSecret,
  config: PoolConfig,
  fetcher: typeof fetch,
): Promise<OAuthSecret> {
  const claude = provider === "claude";
  const url = claude
    ? config.claudeTokenUrl
    : codexAuthUrl(config, "/oauth/token");
  const body = JSON.stringify({
    grant_type: "refresh_token",
    refresh_token: secret.refreshToken,
    client_id: claude ? CLAUDE_CLIENT_ID : CODEX_CLIENT_ID,
  });
  const signal = AbortSignal.timeout(REFRESH_TIMEOUT_MS);
  const init = { method: "POST", headers: JSON_HEADERS, body, signal };
  const reply = await fetcher(url, init)
    .then(async (response) => {
      const payload: unknown = await response.json().catch(() => null);
      return { response, payload };
    })
    .catch(() => null);
  if (reply === null) {
    throw new TransientRefreshError("failed due to a network error or timeout");
  }
  const { status, headers, ok } = reply.response;
  if (status === 400 || status === 401) {
    throw new Error(`OAuth refresh failed with HTTP ${status}.`);
  }
  if (!ok) {
    const retryAfter = retryAfterMs(headers.get("retry-after"), Date.now());
    throw new TransientRefreshError(`failed with HTTP ${status}`, retryAfter);
  }
  const accessToken = text(reply.payload, "access_token");
  if (accessToken === null) {
    throw new TransientRefreshError("returned an unreadable response");
  }
  const lifetime = (positive(reply.payload, "expires_in") ?? 60 * 60) * 1_000;
  const expiry = positive(reply.payload, "expires_at") ?? Date.now() + lifetime;
  const idToken = text(reply.payload, "id_token") ?? secret.idToken;
  return {
    kind: "oauth",
    accessToken,
    refreshToken: text(reply.payload, "refresh_token") ?? secret.refreshToken,
    expiresAt: claude ? epochMs(expiry) : jwtExpiry(accessToken),
    ...(idToken === undefined ? {} : { idToken }),
  };
}

export function parseManualCode(pasted: string, expectedState: string) {
  const trimmed = pasted.trim();
  const query = URL.canParse(trimmed) ? new URL(trimmed).searchParams : null;
  const separator = trimmed.indexOf("#");
  const split = [trimmed.slice(0, separator), trimmed.slice(separator + 1)];
  const parts =
    query?.get("code") != null
      ? [query.get("code"), query.get("state")]
      : separator < 0
        ? [trimmed, ""]
        : split;
  const [code, state] = parts.map((part) => part?.trim() ?? "");
  if (!code) throw new Error("Paste the authorization code.");
  if (state && state !== expectedState) {
    throw new Error("OAuth state mismatch. Start again.");
  }
  return { code, state: expectedState };
}

interface LoginDeps {
  fetch: typeof fetch;
  config(): PoolConfig;
  add(draft: AccountDraft): Promise<Account>;
}

interface BrowserSession {
  sessionId: string;
  verifier: string;
  state: string;
  expiresAt: number;
}

interface DeviceSession {
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
  expiresAt: number;
  nextPollAt: number;
  polling: boolean;
}

export class Logins {
  private browser: BrowserSession | null = null;
  private readonly devices = new Map<string, DeviceSession>();

  constructor(private readonly deps: LoginDeps) {}

  async start(provider: PoolProvider): Promise<LoginStart> {
    const sessionId = randomUUID();
    const now = Date.now();
    if (provider === "claude") {
      const verifier = randomBytes(32).toString("base64url");
      const state = randomBytes(32).toString("base64url");
      const expiresAt = now + LOGIN_TTL_MS;
      this.browser = { sessionId, verifier, state, expiresAt };
      const challenge = createHash("sha256").update(verifier);
      const query = new URLSearchParams({
        code: "true",
        client_id: CLAUDE_CLIENT_ID,
        response_type: "code",
        redirect_uri: CLAUDE_REDIRECT_URI,
        scope: CLAUDE_SCOPES,
        code_challenge: challenge.digest("base64url"),
        code_challenge_method: "S256",
        state,
      });
      const url = `${CLAUDE_AUTHORIZE_URL}?${query.toString()}`;
      return { sessionId, url, expiresAt, device: null };
    }
    for (const [id, session] of this.devices) {
      if (now >= session.expiresAt) this.devices.delete(id);
    }
    const step = "Codex device login";
    const pathname = "/api/accounts/deviceauth/usercode";
    const body = JSON.stringify({ client_id: CODEX_CLIENT_ID });
    const init = { method: "POST", headers: JSON_HEADERS, body };
    const issued = await this.request(step, this.codexUrl(pathname), init);
    const deviceAuthId = text(issued, "device_auth_id");
    const userCode = text(issued, "user_code");
    const intervalMs = Math.round(Number(dig(issued, "interval")) * 1_000);
    if (deviceAuthId === null || userCode === null || !(intervalMs > 0)) {
      throw new Error(`${step} returned an invalid response. Start again.`);
    }
    const lifetime = (positive(issued, "expires_in") ?? Infinity) * 1_000;
    const stated = Date.parse(text(issued, "expires_at") ?? "");
    const granted = Number.isNaN(stated) ? now + lifetime : stated;
    const expiresAt = Math.min(now + LOGIN_TTL_MS, granted);
    const pace = { intervalMs, nextPollAt: now + intervalMs, polling: false };
    const session = { deviceAuthId, userCode, expiresAt, ...pace };
    this.devices.set(sessionId, session);
    const url = this.codexUrl("/codex/device");
    return { sessionId, url, expiresAt, device: { userCode, intervalMs } };
  }

  async complete(sessionId: string, pasted: string): Promise<Account> {
    const session = this.browser;
    if (session === null || session.sessionId !== sessionId) {
      throw new Error("Login session was not found. Start again.");
    }
    this.browser = null;
    if (Date.now() >= session.expiresAt) {
      throw new Error("Code expired, start again.");
    }
    const config = this.deps.config();
    const exchange = "Claude token exchange";
    const tokens = await this.request(exchange, config.claudeTokenUrl, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        grant_type: "authorization_code",
        ...parseManualCode(pasted, session.state),
        code_verifier: session.verifier,
        redirect_uri: CLAUDE_REDIRECT_URI,
        client_id: CLAUDE_CLIENT_ID,
      }),
    });
    const accessToken = text(tokens, "access_token");
    const refreshToken = text(tokens, "refresh_token");
    const lifetime = positive(tokens, "expires_in");
    if (accessToken === null || refreshToken === null || lifetime === null) {
      throw new Error(`${exchange} returned an invalid response. Start again.`);
    }
    const authorization = `Bearer ${accessToken}`;
    const profile = await this.request(
      "Claude profile lookup",
      new URL("/api/oauth/profile", config.anthropicUpstreamBaseUrl),
      { headers: { authorization, "anthropic-beta": CLAUDE_OAUTH_BETA } },
    );
    const read = (...keys: string[]) => text(profile, ...keys);
    const has = (plan: string) => dig(profile, "account", `has_claude_${plan}`);
    const plan = has("pro") ? "pro" : read("account", "subscription_type");
    const address = email(profile, "account", "email");
    const expiresAt = Date.now() + lifetime * 1_000;
    return this.deps.add({
      provider: "claude",
      label:
        read("account", "display_name") ??
        address ??
        read("organization", "name") ??
        "Claude account",
      email: address,
      accountUuid: z.uuid().safeParse(read("account", "uuid")).data ?? null,
      subscriptionType:
        (has("max") ? "max" : plan) ??
        read("organization", "organization_type"),
      rateLimitTier:
        read("account", "rate_limit_tier") ??
        read("organization", "rate_limit_tier"),
      secret: { kind: "oauth", accessToken, refreshToken, expiresAt },
    });
  }

  async poll(sessionId: string): Promise<LoginPoll> {
    const session = this.devices.get(sessionId);
    const fail = (message: string): LoginPoll => {
      this.devices.delete(sessionId);
      return { status: "error", message };
    };
    if (session === undefined) {
      return fail("Login session was not found. Start again.");
    }
    const now = Date.now();
    if (now >= session.expiresAt) return fail("Code expired, start again.");
    if (session.polling || now < session.nextPollAt) {
      return { status: "pending" };
    }
    session.polling = true;
    session.nextPollAt = now + session.intervalMs;
    const { deviceAuthId: device_auth_id, userCode: user_code } = session;
    const url = this.codexUrl("/api/accounts/deviceauth/token");
    const body = JSON.stringify({ device_auth_id, user_code });
    const reply = await this.deps
      .fetch(url, { method: "POST", headers: JSON_HEADERS, body })
      .then(async (response) => {
        const payload: unknown = await response.json().catch(() => null);
        return { response, payload };
      })
      .catch(() => null)
      .finally(() => (session.polling = false));
    if (reply === null) return { status: "pending" };
    const { status, ok } = reply.response;
    const code = text(reply.payload, "error", "code")?.toLowerCase() ?? "";
    if (code.includes("slow_down")) {
      session.intervalMs += 5_000;
      session.nextPollAt = Date.now() + session.intervalMs;
      return { status: "pending" };
    }
    if (code.includes("expired")) return fail("Code expired, start again.");
    if (code.includes("denied") || code.includes("declined")) {
      return fail("Codex authorization was declined. Start again.");
    }
    const waiting = status === 403 || status === 404 || status >= 500;
    if (!ok && waiting) return { status: "pending" };
    const grant = text(reply.payload, "authorization_code");
    const verifier = text(reply.payload, "code_verifier");
    if (!ok || grant === null || verifier === null) {
      const problem = ok
        ? "returned an invalid response"
        : `failed (HTTP ${status})`;
      return fail(`Codex authorization ${problem}. Start again.`);
    }
    this.devices.delete(sessionId);
    try {
      const account = await this.exchangeDeviceGrant(grant, verifier);
      return { status: "complete", account };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  private async exchangeDeviceGrant(
    code: string,
    verifier: string,
  ): Promise<Account> {
    const step = "Codex token exchange";
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.codexUrl("/deviceauth/callback"),
      client_id: CODEX_CLIENT_ID,
      code_verifier: verifier,
    });
    const encoding = "application/x-www-form-urlencoded";
    const headers = { accept: "application/json", "content-type": encoding };
    const init = { method: "POST", headers, body: form.toString() };
    const tokens = await this.request(
      step,
      this.codexUrl("/oauth/token"),
      init,
    );
    const accessToken = text(tokens, "access_token");
    const refreshToken = text(tokens, "refresh_token");
    const idToken = text(tokens, "id_token");
    if (accessToken === null || refreshToken === null || idToken === null) {
      throw new Error(`${step} returned an invalid response. Start again.`);
    }
    return this.deps.add(codexDraft(accessToken, refreshToken, idToken));
  }

  private codexUrl(pathname: string): string {
    return codexAuthUrl(this.deps.config(), pathname);
  }

  private async request(
    step: string,
    url: string | URL,
    init: RequestInit,
  ): Promise<unknown> {
    const response = await this.deps.fetch(url, init);
    if (response.ok) return response.json().catch(() => null);
    await response.body?.cancel();
    throw new Error(`${step} failed (HTTP ${response.status}). Start again.`);
  }
}
