import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type {
  Account,
  AccountQuota,
  AccountSummary,
  ModelFamily,
  PoolConfig,
  PoolProvider,
} from "./contract.js";
import * as limits from "./limits.js";
import {
  CLAUDE_OAUTH_BETA,
  refreshOAuth,
  TransientRefreshError,
} from "./oauth.js";
import {
  parseClaudeRequest,
  parseCodexRequest,
  upstreamHeaders,
  upstreamUrl,
  type Bytes,
  type ParsedRequest,
} from "./request.js";
import type {
  AccountSecret,
  AccountStore,
  HubTokens,
  PoolState,
} from "./store.js";

const USAGE_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;
const EXHAUSTED_USAGE_REFRESH_INTERVAL_MS = 30 * 1_000;
const OAUTH_REFRESH_WINDOW_MS = 5 * 60 * 1_000;
const MAX_REFRESH_BACKOFF_MS = 60_000;
const MAX_INLINE_HOLD_MS = 20_000;
const UPSTREAM_REJECTION_HOLD_MS = 60_000;
const FAILURE_DETAIL_TIMEOUT_MS = 250;
const MAX_FAILURE_DETAIL_LENGTH = 1_024;
const FAILOVER_STATUSES = [401, 403, 408, 500, 502, 503, 504, 529];
const CODEX_REQUEST_HEADERS =
  "accept content-encoding content-type openai-beta originator session-id session_id thread-id user-agent x-openai-internal-codex-responses-lite";
const DROPPED_RESPONSE_HEADERS =
  /^(?:content-encoding|content-length|connection|keep-alive|proxy-authenticate|proxy-authorization|te|trailer|transfer-encoding|upgrade)$/u;

interface Upstream {
  name: string;
  allowed: readonly string[];
  prefixes: readonly string[];
  parse(body: Bytes, headers: Headers): ParsedRequest;
  url(request: Request, config: PoolConfig): URL;
  observe: typeof limits.claudeQuotaFromHeaders;
  isQuotaRejection(headers: Headers): boolean;
  errorBody(status: number, message: string): object;
}

const UPSTREAMS: Record<PoolProvider, Upstream> = {
  claude: {
    name: "Anthropic",
    allowed: ["accept", "content-type", "user-agent", "x-app"],
    prefixes: ["anthropic-", "x-stainless-"],
    parse: parseClaudeRequest,
    url: (request, config) =>
      upstreamUrl(request, config.anthropicUpstreamBaseUrl),
    observe: limits.claudeQuotaFromHeaders,
    isQuotaRejection: limits.isClaudeQuotaRejection,
    errorBody(status, message) {
      const limited = status === 429 ? "rate_limit_error" : "api_error";
      const type = status === 401 ? "authentication_error" : limited;
      return { type: "error", error: { type, message } };
    },
  },
  codex: {
    name: "ChatGPT",
    allowed: CODEX_REQUEST_HEADERS.split(" "),
    prefixes: ["x-codex-", "x-stainless-"],
    parse: parseCodexRequest,
    url: (request, config) =>
      upstreamUrl(request, config.codexUpstreamBaseUrl, "v1/"),
    observe: (headers, previous, _family, now) =>
      limits.codexQuotaFromHeaders(headers, previous, now),
    isQuotaRejection: limits.isCodexQuotaRejection,
    errorBody(status, message) {
      const limited = status === 429;
      const type = limited ? "rate_limit_error" : "api_error";
      const code = limited ? "rate_limit_exceeded" : null;
      return { error: { message, type, code } };
    },
  },
};

export interface HubDeps {
  accounts: AccountStore;
  tokens: HubTokens;
  state: PoolState;
  config(): PoolConfig;
  fetch: typeof fetch;
  warn(message: string): void;
  changed(): void;
}

interface Failure {
  status: number;
  message: string;
  retryAfter?: string | null;
}

interface Flight {
  response: Response;
  release(): void;
}

interface Route {
  request: Request;
  signal: AbortSignal;
  parsed: ParsedRequest;
  provider: PoolProvider;
  hostId: string;
  family: ModelFamily;
  key: string | null;
  parentKey: string | null;
  attempted: Set<string>;
  waited: Set<string>;
  previous: string | null;
  pinned?: string | null;
}

interface Selection {
  account: Account;
  quota: AccountQuota;
  pinned: boolean;
  commit(): void;
}

interface Backoff {
  retryAt: number;
  delayMs: number;
  error: TransientRefreshError;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function transportCode(error: unknown): string {
  let cause = error;
  for (let depth = 0; depth < 6 && cause instanceof Error; depth += 1) {
    if ("code" in cause && typeof cause.code === "string") return cause.code;
    cause = cause.cause;
  }
  return "unclassified transport error";
}

function errorResponse(provider: PoolProvider, failure: Failure): Response {
  const { status, message, retryAfter } = failure;
  const headers = new Headers();
  if (retryAfter != null) headers.set("retry-after", retryAfter);
  const body = UPSTREAMS[provider].errorBody(status, message);
  return Response.json(body, { status, headers });
}

async function failureDetail({ response, release }: Flight): Promise<string> {
  const text = response.text().catch(() => "");
  const deadline = sleep(FAILURE_DETAIL_TIMEOUT_MS, "", { ref: false });
  const detail = await Promise.race([text, deadline]);
  release();
  return detail.slice(0, MAX_FAILURE_DETAIL_LENGTH).trim();
}

function clientResponse({ response, release }: Flight): Response {
  const headers = new Headers();
  for (const [name, value] of response.headers) {
    if (!DROPPED_RESPONSE_HEADERS.test(name)) headers.append(name, value);
  }
  const { status, statusText } = response;
  if (response.body === null) {
    release();
    return new Response(null, { status, statusText, headers });
  }
  const reader = response.body.getReader();
  const contentType = response.headers.get("content-type") ?? "";
  const eventStream = /^\s*text\/event-stream\s*(?:;|$)/iu.test(contentType);
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (!chunk.done) return controller.enqueue(chunk.value);
        release();
        controller.close();
      } catch (error) {
        release();
        if (!eventStream) return controller.error(error);
        const failure = { type: "api_error", message: errorMessage(error) };
        const data = JSON.stringify({ type: "error", error: failure });
        const frame = `event: error\ndata: ${data}\n\n`;
        controller.enqueue(new TextEncoder().encode(frame));
        controller.close();
      }
    },
    async cancel() {
      release();
      await reader.cancel().catch(() => undefined);
    },
  });
  return new Response(body, { status, statusText, headers });
}

export class Hub {
  readonly stopped = new AbortController();
  private readonly inFlight = new Map<string, number>();
  private readonly refreshes = new Map<string, Promise<AccountSecret>>();
  private readonly backoffs = new Map<string, Backoff>();
  private readonly usageFlights = new Map<string, Promise<void>>();
  private readonly usageRefreshedAt = new Map<string, number>();

  constructor(private readonly deps: HubDeps) {}

  async start(signal: AbortSignal): Promise<void> {
    const pause = { signal, ref: false };
    while (!signal.aborted) {
      await this.refreshUsage();
      await sleep(USAGE_REFRESH_INTERVAL_MS, null, pause).catch(() => null);
    }
  }

  async handle(request: Request, provider: PoolProvider): Promise<Response> {
    const authorization = request.headers.get("authorization") ?? "";
    const bearer = /^Bearer\s+(.+)$/iu.exec(authorization)?.[1];
    const presented = request.headers.get("x-bb-account-pool-token") ?? bearer;
    const hostId = this.deps.tokens.authenticate(presented ?? null);
    const reply = (status: number, message: string) =>
      errorResponse(provider, { status, message });
    if (hostId === null) {
      return reply(401, "Invalid Account Pooler bearer token.");
    }
    const signal = AbortSignal.any([request.signal, this.stopped.signal]);
    try {
      const body = new Uint8Array(await request.arrayBuffer());
      return await this.forward(request, body, provider, hostId, signal);
    } catch (error) {
      if (!signal.aborted) throw error;
      return request.signal.aborted
        ? reply(499, "Account Pooler request was canceled.")
        : reply(503, "Account Pooler stopped accepting requests.");
    }
  }

  async refreshUsage(accountId?: string, recover = false): Promise<void> {
    const all = accountId === undefined;
    const accounts = (await this.deps.accounts.list()).filter(
      (account) => account.enabled && (all || account.id === accountId),
    );
    const interval = all ? USAGE_REFRESH_INTERVAL_MS : 0;
    const refresh = (account: Account) =>
      this.refreshAccountUsage(account, interval, recover);
    await Promise.all(accounts.map(refresh));
  }

  async summary(): Promise<AccountSummary[]> {
    const now = Date.now();
    const threshold = this.deps.config().switchThreshold;
    return (await this.deps.accounts.list()).map((account) => {
      const quota = this.deps.state.quota(account.id);
      const status = limits.accountStatus(account, quota, threshold, now);
      const reset = limits.blockingResetAt(quota, null, threshold, now);
      const blockedUntil = status === "held" ? quota.heldUntil : reset;
      const inFlight = this.inFlight.get(account.id) ?? 0;
      return { ...account, ...quota, inFlight, status, blockedUntil };
    });
  }

  private async forward(
    request: Request,
    body: Bytes,
    provider: PoolProvider,
    hostId: string,
    signal: AbortSignal,
  ): Promise<Response> {
    const parsed = UPSTREAMS[provider].parse(body, request.headers);
    const key = (id: string | null) =>
      id === null ? null : JSON.stringify([provider, hostId, id]);
    const route: Route = {
      request,
      signal,
      parsed,
      provider,
      hostId,
      family: parsed.family,
      key: key(parsed.affinityId),
      parentKey: key(parsed.parentAffinityId),
      attempted: new Set(),
      waited: new Set(),
      previous: null,
    };
    let failure: Failure | null = null;
    for (let rechecked = false; ;) {
      signal.throwIfAborted();
      const selected = await this.select(route);
      const spent = selected === null || this.isSpent(selected.quota, route);
      if (spent && !rechecked) {
        rechecked = true;
        await this.recheckExhausted(route);
        continue;
      }
      if (selected === null) break;
      const { id } = selected.account;
      const heldMs = (selected.quota.heldUntil ?? 0) - Date.now();
      if (heldMs > 0 && heldMs <= MAX_INLINE_HOLD_MS && !route.waited.has(id)) {
        route.waited.add(id);
        await sleep(heldMs, undefined, { signal });
        continue;
      }
      route.attempted.add(id);
      route.previous = id;
      if (heldMs > 0) {
        const message =
          "The current Account Pooler account is temporarily rate limited.";
        const retryAfter = String(Math.ceil(heldMs / 1_000));
        failure = { status: 429, message, retryAfter };
        if (selected.pinned) break;
        continue;
      }
      const outcome = await this.attempt(selected, route);
      if (outcome instanceof Response) return outcome;
      failure = outcome ?? failure;
    }
    return errorResponse(provider, failure ?? (await this.noEligible(route)));
  }

  private async attempt(
    selected: Selection,
    route: Route,
  ): Promise<Response | Failure | null> {
    const { account } = selected;
    const { id } = account;
    const { state } = this.deps;
    const { signal, family } = route;
    const upstream = UPSTREAMS[route.provider];
    let secret: AccountSecret;
    try {
      secret = await this.freshSecret(account);
    } catch (error) {
      return this.refreshFailure(id, error);
    }
    const body = route.parsed.forAccount(account);
    let paced = route.waited.has(id);
    for (let authRetried = false; ;) {
      signal.throwIfAborted();
      const flight = await this.send(route, body, account, secret);
      if (flight === null) {
        signal.throwIfAborted();
        const message = `Account Pooler could not reach ${upstream.name}.`;
        return { status: 502, message };
      }
      const { status, headers } = flight.response;
      const now = Date.now();
      const seen = upstream.observe(headers, state.quota(id), family, now);
      state.setQuota(id, seen);
      const retryAfter = headers.get("retry-after");
      if (status === 429 && upstream.isQuotaRejection(headers)) {
        flight.release();
        const explained = this.isSpent(seen, route);
        if (!explained) state.setQuota(id, limits.blocked(seen, now));
        return null;
      }
      if (status === 429) {
        const waitMs = limits.retryAfterMs(retryAfter, now);
        state.setQuota(id, { ...seen, heldUntil: now + waitMs });
        if (!paced && waitMs <= MAX_INLINE_HOLD_MS) {
          paced = true;
          flight.release();
          await sleep(waitMs, undefined, { signal });
          continue;
        }
        if (!selected.pinned) {
          const message = await failureDetail(flight);
          const wait = String(Math.ceil(waitMs / 1_000));
          return { status, message, retryAfter: wait };
        }
      }
      if (!FAILOVER_STATUSES.includes(status)) {
        if (flight.response.ok) selected.commit();
        return clientResponse(flight);
      }
      const detail = await failureDetail(flight);
      const message = detail || `${upstream.name} returned HTTP ${status}.`;
      const failure = { status, message, retryAfter };
      if (status !== 401 && status !== 403) return failure;
      if (secret.kind !== "oauth") {
        this.markError(id, message);
        return failure;
      }
      if (authRetried) {
        const heldUntil = Date.now() + UPSTREAM_REJECTION_HOLD_MS;
        state.setQuota(id, { ...state.quota(id), heldUntil });
        const reason = `${upstream.name} returned HTTP ${status} for a freshly refreshed credential, so the Account Pooler is treating it as an upstream failure`;
        return { status: 503, message: `${reason}: ${message}` };
      }
      authRetried = true;
      try {
        secret = await this.freshSecret(account, secret.accessToken);
      } catch (error) {
        return this.refreshFailure(id, error) ?? failure;
      }
    }
  }

  private async send(
    { request, signal }: Route,
    body: Bytes,
    account: Account,
    secret: AccountSecret,
  ): Promise<Flight | null> {
    const { provider, id, codexAccountId } = account;
    const upstream = UPSTREAMS[provider];
    const { allowed, prefixes } = upstream;
    const headers = upstreamHeaders(request.headers, allowed, prefixes);
    if (secret.kind === "api-key") headers.set("x-api-key", secret.apiKey);
    else headers.set("authorization", `Bearer ${secret.accessToken}`);
    if (provider === "codex") {
      headers.set("chatgpt-account-id", codexAccountId ?? "");
    }
    const { method } = request;
    const payload = method === "GET" || method === "HEAD" ? {} : { body };
    const controller = new AbortController();
    const count = (change: number) => {
      const next = (this.inFlight.get(id) ?? 0) + change;
      if (next > 0) this.inFlight.set(id, next);
      else this.inFlight.delete(id);
    };
    count(1);
    const release = () => {
      if (controller.signal.aborted) return;
      controller.abort();
      count(-1);
    };
    try {
      const url = upstream.url(request, this.deps.config());
      const aborts = AbortSignal.any([signal, controller.signal]);
      const init = { method, headers, signal: aborts, ...payload };
      return { response: await this.deps.fetch(url, init), release };
    } catch (error) {
      release();
      if (signal.aborted) return null;
      const code = transportCode(error);
      this.deps.warn(`Account Pooler ${provider} transport failed: ${code}.`);
      return null;
    }
  }

  private isSpent(
    quota: AccountQuota,
    scope: { family: ModelFamily | null },
  ): boolean {
    const threshold = this.deps.config().switchThreshold;
    return limits.isExhausted(quota, scope.family, threshold, Date.now());
  }

  private async select(route: Route): Promise<Selection | null> {
    const { state } = this.deps;
    const { provider, attempted, key } = route;
    const now = Date.now();
    const shared = { family: null };
    const accounts = (await this.deps.accounts.list()).filter(
      (account) => account.provider === provider,
    );
    const usable = (
      quota: AccountQuota,
      scope: { family: ModelFamily | null },
    ) => !this.isSpent(quota, scope) || quota.extraUsage === true;
    const available = accounts
      .filter((account) => account.enabled)
      .map((account) => ({ account, quota: state.quota(account.id) }))
      .filter(({ quota }) => quota.error === null && usable(quota, shared));
    type Candidate = (typeof available)[number];
    const fresh = ({ account }: Candidate) => !attempted.has(account.id);
    const ready = ({ quota }: Candidate) => (quota.heldUntil ?? 0) <= now;
    const paid = available.filter(({ quota }) => usable(quota, route));
    const included = paid.filter(({ quota }) => !this.isSpent(quota, route));
    const preferred = included.some((entry) => fresh(entry) && ready(entry));
    const eligible = preferred ? included : paid;
    const unattempted = eligible.filter(fresh);
    const find = (id: string | null) =>
      unattempted.find((candidate) => candidate.account.id === id);
    const isEligible = (id: string | null) =>
      eligible.some((candidate) => candidate.account.id === id);
    const boundId = state.boundAccount(key);
    const parentId = isEligible(boundId)
      ? null
      : state.boundAccount(route.parentKey);
    const activeId = state.active.get(provider) ?? null;
    const anchorId = route.previous ?? boundId ?? activeId;
    const anchor = accounts.findIndex((account) => account.id === anchorId);
    const ring = [
      ...accounts.slice(anchor + 1),
      ...accounts.slice(0, anchor + 1),
    ];
    const next = ring
      .map((account) => find(account.id))
      .find((candidate) => candidate !== undefined && ready(candidate));
    const sticky = boundId === null && route.previous === null;
    const inherited = find(parentId);
    const chosen =
      find(boundId) ??
      inherited ??
      (sticky ? find(activeId) : undefined) ??
      next;
    if (chosen === undefined) return null;
    const { id } = chosen.account;
    if (route.pinned === undefined) {
      route.pinned = boundId ?? inherited?.account.id ?? null;
    }
    if (key !== null && (boundId === null || boundId === id)) {
      state.bind(key, id);
    }
    if (activeId === null) state.active.set(provider, id);
    const detoured = (accountId: string | null) =>
      available.some(
        ({ account, quota }) =>
          account.id === accountId &&
          !this.isSpent(quota, shared) &&
          this.isSpent(quota, route),
      );
    return {
      ...chosen,
      pinned: id === route.pinned,
      commit: () => {
        if (key !== null && !detoured(boundId)) state.bind(key, id);
        const failed = activeId !== null && attempted.has(activeId);
        const moved = failed || activeId === id || !isEligible(activeId);
        if (moved && !detoured(activeId)) state.active.set(provider, id);
        state.touch();
      },
    };
  }

  private async recheckExhausted(route: Route): Promise<void> {
    const accounts = (await this.deps.accounts.list()).filter((account) => {
      const quota = this.deps.state.quota(account.id);
      const candidate =
        account.provider === route.provider &&
        account.enabled &&
        !route.attempted.has(account.id);
      return candidate && quota.error === null && this.isSpent(quota, route);
    });
    const interval = EXHAUSTED_USAGE_REFRESH_INTERVAL_MS;
    const refresh = (account: Account) =>
      this.refreshAccountUsage(account, interval);
    await Promise.all(accounts.map(refresh));
  }

  private async noEligible(route: Route): Promise<Failure> {
    const { state, config } = this.deps;
    const enabled = (await this.deps.accounts.list()).filter(
      (account) => account.provider === route.provider && account.enabled,
    );
    if (enabled.length === 0) {
      return { status: 503, message: "Account Pooler has no enabled account" };
    }
    const now = Date.now();
    const { switchThreshold } = config();
    const resets = enabled.flatMap(({ id }) => {
      const quota = state.quota(id);
      const family = route.family;
      const reset = limits.blockingResetAt(quota, family, switchThreshold, now);
      const resetAt = Math.max(quota.heldUntil ?? 0, reset ?? 0);
      return quota.error === null && resetAt > now ? [resetAt] : [];
    });
    const next = resets.length === 0 ? now + 1_000 : Math.min(...resets);
    const retryAfter = String(Math.max(1, Math.ceil((next - now) / 1_000)));
    const message = "No Account Pooler account is currently eligible.";
    return { status: 429, message, retryAfter };
  }

  private markError(accountId: string, message: string): void {
    const quota = this.deps.state.quota(accountId);
    const error = message.slice(0, 1_000);
    this.deps.state.setQuota(accountId, { ...quota, error });
    this.deps.changed();
  }

  private refreshFailure(accountId: string, error: unknown): Failure | null {
    const message = errorMessage(error);
    if (error instanceof TransientRefreshError) return { status: 503, message };
    this.markError(accountId, message);
    return null;
  }

  private async freshSecret(
    account: Account,
    rejectedToken?: string,
  ): Promise<AccountSecret> {
    for (;;) {
      const running = this.refreshes.get(account.id);
      if (running === undefined) break;
      const secret = await running;
      const stale =
        secret.kind === "oauth" && secret.accessToken === rejectedToken;
      if (!stale) return secret;
    }
    const flight = this.loadSecret(account, rejectedToken).finally(() =>
      this.refreshes.delete(account.id),
    );
    this.refreshes.set(account.id, flight);
    return flight;
  }

  private async loadSecret(
    account: Account,
    rejectedToken?: string,
  ): Promise<AccountSecret> {
    const { accounts, config, fetch: fetcher } = this.deps;
    const { id, provider } = account;
    const secret = await accounts.readSecret(id);
    if (secret.kind !== "oauth") return secret;
    const now = Date.now();
    const forced = secret.accessToken === rejectedToken;
    const expiresAt = secret.expiresAt ?? Number.POSITIVE_INFINITY;
    if (!forced && expiresAt > now + OAUTH_REFRESH_WINDOW_MS) return secret;
    const usable = !forced && expiresAt > now;
    const backoff = this.backoffs.get(id);
    if (backoff !== undefined && now < backoff.retryAt) {
      if (usable) return secret;
      throw backoff.error;
    }
    try {
      const refreshed = await refreshOAuth(provider, secret, config(), fetcher);
      await accounts.writeSecret(id, refreshed);
      this.backoffs.delete(id);
      return refreshed;
    } catch (error) {
      if (!(error instanceof TransientRefreshError)) throw error;
      const doubled = backoff === undefined ? 1_000 : backoff.delayMs * 2;
      const wanted = Math.max(doubled, error.retryAfterMs);
      const delayMs = Math.min(MAX_REFRESH_BACKOFF_MS, wanted);
      this.backoffs.set(id, { retryAt: now + delayMs, delayMs, error });
      if (usable) return secret;
      throw error;
    }
  }

  private refreshAccountUsage(
    account: Account,
    minIntervalMs: number,
    recover = false,
  ): Promise<void> {
    const { id } = account;
    const busy = account.kind !== "oauth" || this.inFlight.has(id);
    const running = this.usageFlights.get(id);
    if (busy || running !== undefined) return running ?? Promise.resolve();
    const now = Date.now();
    const last = this.usageRefreshedAt.get(id) ?? Number.NEGATIVE_INFINITY;
    if (now - last < minIntervalMs) return Promise.resolve();
    this.usageRefreshedAt.set(id, now);
    const flight = this.pollUsage(account, recover)
      .catch(() => undefined)
      .finally(() => {
        this.usageFlights.delete(id);
        this.deps.changed();
      });
    this.usageFlights.set(id, flight);
    return flight;
  }

  private async pollUsage(account: Account, recover: boolean): Promise<void> {
    const { state, accounts, config } = this.deps;
    const { id, provider, codexAccountId } = account;
    const failed = state.quota(id).error !== null;
    if (failed && !recover) return;
    const stored = failed ? await accounts.readSecret(id) : null;
    const rejected = stored?.kind === "oauth" ? stored.accessToken : undefined;
    const secret = await this.freshSecret(account, rejected).catch(
      (error: unknown) => void this.refreshFailure(id, error),
    );
    if (secret?.kind !== "oauth") return;
    if (failed) state.setQuota(id, { ...state.quota(id), error: null });
    const authorization = `Bearer ${secret.accessToken}`;
    const identity: Record<string, string> =
      provider === "claude"
        ? { "anthropic-beta": CLAUDE_OAUTH_BETA }
        : { "chatgpt-account-id": codexAccountId ?? "", originator: "bb" };
    const headers = { authorization, accept: "application/json", ...identity };
    const get = async (url: URL): Promise<unknown> => {
      const timeout = provider === "claude" ? 10_000 : 15_000;
      const signal = AbortSignal.timeout(timeout);
      const response = await this.deps.fetch(url, { headers, signal });
      if (response.ok) return response.json().catch(() => null);
      await response.body?.cancel();
      return null;
    };
    const { anthropicUpstreamBaseUrl: claudeBase, codexUpstreamBaseUrl } =
      config();
    const codexBase = codexUpstreamBaseUrl.replace(/\/+$/u, "");
    const claude = provider === "claude";
    const usage = await get(
      claude
        ? new URL("/api/oauth/usage", claudeBase)
        : new URL("wham/usage", codexBase),
    );
    const read = claude
      ? limits.claudeQuotaFromUsage
      : limits.codexQuotaFromUsage;
    const quota = read(usage, state.quota(id), Date.now());
    if (quota !== null) state.setQuota(id, quota);
    const plan = z
      .string()
      .trim()
      .min(1)
      .safeParse(limits.dig(usage, "plan_type"));
    if (!claude && plan.success && plan.data !== account.subscriptionType) {
      await accounts.update(id, { subscriptionType: plan.data });
    }
    if (!claude || account.accountUuid !== null) return;
    const profileUrl = new URL("/api/oauth/profile", claudeBase);
    const uuid = limits.dig(await get(profileUrl), "account", "uuid");
    const accountUuid = z.uuid().safeParse(uuid).data;
    if (accountUuid !== undefined) await accounts.update(id, { accountUuid });
  }
}
