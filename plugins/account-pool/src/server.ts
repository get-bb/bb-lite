import path from "node:path";
import {
  machines,
  sessions,
  type PluginServerApi,
  type ProviderEnvEntry,
} from "@bb/plugin";
import { EnvHttpProxyAgent } from "undici";
import { registerPoolCli } from "./cli.js";
import { configSchema, HUB_PATH, pool, type PoolProvider } from "./contract.js";
import { Hub } from "./hub.js";
import { importAccount, Logins, type AccountDraft } from "./oauth.js";
import { AccountStore, HubTokens, PoolState } from "./store.js";

const NEEDS_ACCOUNT =
  "Add and enable a Claude or Codex account with `bb pool account add`.";
const OK = { status: 200 };
const CLAUDE_ROUTES = ["/v1/messages", "/v1/messages/count_tokens"];
const CODEX_ROUTES =
  "/v1/responses /v1/images/generations /v1/images/edits /v1/alpha/search";

export default async function accountPool(bb: PluginServerApi): Promise<void> {
  const { kv } = bb.storage;
  let config = configSchema.parse((await kv.get("config")) ?? {});
  const secretsDir = path.join(bb.dataDir, "secrets", "accounts");
  const accounts = new AccountStore(kv, secretsDir);
  const tokens = new HubTokens(secretsDir);
  await tokens.load();
  const state = new PoolState(path.join(bb.dataDir, "state.json"));
  await state.load();
  const dispatcher = new EnvHttpProxyAgent({ allowH2: false });
  const upstreamFetch: typeof fetch = (input, init) => {
    const options = { ...init, dispatcher };
    return fetch(input, options);
  };
  const changed = () => bb.changed(pool.status);
  const getConfig = () => config;
  const { warn } = bb.log;
  const shared = { config: getConfig, fetch: upstreamFetch };
  const hub = new Hub({ accounts, tokens, state, warn, changed, ...shared });
  bb.onDispose(async () => {
    hub.stopped.abort();
    await state.flush();
    await dispatcher.destroy();
  });

  const isRouted = async (provider: PoolProvider) =>
    (await kv.get(`routing.${provider}`)) !== false;
  const canServe = async (provider: PoolProvider): Promise<boolean> => {
    if (!(await isRouted(provider))) return false;
    for (const account of await accounts.list()) {
      if (!account.enabled || account.provider !== provider) continue;
      const secret = await accounts.readSecret(account.id).catch(() => null);
      if (secret !== null) return true;
    }
    return false;
  };
  const adopt = async (draft: AccountDraft, label?: string, priority = 100) => {
    const { secret, ...identity } = draft;
    const shown = { label: label ?? draft.label, priority };
    const defaults = { kind: "oauth", enabled: true } as const;
    const added = { ...identity, ...shown, ...defaults };
    const account = await accounts.add(added, secret);
    await hub.refreshUsage(account.id, true);
    changed();
    return account;
  };
  const missing = (id: string): never => {
    throw new Error(`Account ${id} does not exist.`);
  };

  const logins = new Logins({ ...shared, add: adopt });
  const remove = async (id: string) => {
    if (!(await accounts.remove(id))) missing(id);
    state.setQuota(id, null);
    changed();
  };

  bb.implement(pool.status, async () => {
    const hosts = await bb.call(machines.list, {});
    const hostName = (id: string | null) =>
      hosts.find((host) => host.id === id)?.name ?? null;
    const hostIds = tokens.hostIds();
    return {
      route: HUB_PATH,
      hosts: hostIds.map((hostId) => ({
        hostId,
        hostName: hostName(hostId),
      })),
      accounts: await hub.summary(),
      routing: {
        claude: await isRouted("claude"),
        codex: await isRouted("codex"),
      },
      config,
    };
  });
  bb.implement(
    pool.accountAdd,
    async ({ provider, apiKey, label, priority }) => {
      const named = label ?? undefined;
      if (apiKey === null) {
        return adopt(await importAccount(provider), named, priority);
      }
      if (provider !== "claude") {
        throw new Error("API keys are only supported for the claude provider.");
      }
      const blank = { email: null, accountUuid: null, subscriptionType: null };
      const shown = { label: named ?? "Claude API key", priority };
      const kind = {
        kind: "api-key",
        enabled: true,
        rateLimitTier: null,
      } as const;
      const secret = { kind: "api-key", apiKey } as const;
      const added = { provider, ...blank, ...shown, ...kind };
      const account = await accounts.add(added, secret);
      changed();
      return account;
    },
  );
  bb.implement(pool.accountUpdate, async ({ id, enabled, priority }) => {
    const patch = {
      ...(enabled === undefined ? {} : { enabled }),
      ...(priority === undefined ? {} : { priority }),
    };
    const account = (await accounts.update(id, patch)) ?? missing(id);
    if (enabled === true) {
      const cleared = { error: null, heldUntil: null };
      state.setQuota(id, { ...state.quota(id), ...cleared });
      await hub.refreshUsage(id, true);
    }
    changed();
    return account;
  });
  bb.implement(pool.accountRefresh, async ({ id }) => {
    const listed = await accounts.list();
    if (!listed.some((account) => account.id === id)) missing(id);
    await hub.refreshUsage(id, true);
    changed();
    return null;
  });
  bb.implement(pool.routingSet, async ({ provider, enabled }) => {
    await kv.set(`routing.${provider}`, enabled);
    changed();
    return null;
  });
  bb.implement(pool.configSet, async ({ switchThreshold }) => {
    const next = configSchema.parse({ ...config, switchThreshold });
    await kv.set("config", next);
    config = next;
    changed();
    return null;
  });
  bb.implement(pool.loginStart, ({ provider }) => logins.start(provider));
  bb.implement(pool.loginComplete, ({ sessionId, code }) =>
    logins.complete(sessionId, code),
  );
  bb.implement(pool.loginPoll, ({ sessionId }) => logins.poll(sessionId));
  registerPoolCli(bb, remove);

  const contribute = (
    providerId: string,
    provider: PoolProvider,
    entries: (token: string) => ProviderEnvEntry[],
  ) =>
    bb.on(sessions.env, { providerId }, async ({ hostId }, next) => {
      if (hostId === null || !(await canServe(provider))) return next();
      return [...entries(await tokens.forHost(hostId)), ...(await next())];
    });
  const health = (providerId: string, provider: PoolProvider) =>
    bb.on(sessions.environmentHealth, { providerId }, async (_input, next) => {
      const read = await next();
      if (!(await canServe(provider))) return read;
      const statusMessage =
        "Credentials are provided by the Account Pooler hub.";
      return { ...read, label: "Proxied", statusMessage };
    });
  health("claude-code", "claude");
  health("codex", "codex");
  contribute("claude-code", "claude", (token) => [
    { name: "ANTHROPIC_BASE_URL", value: { serverPath: HUB_PATH } },
    { name: "ANTHROPIC_AUTH_TOKEN", value: token },
    {
      name: "ANTHROPIC_CUSTOM_HEADERS",
      value: `x-bb-account-pool-token: ${token}`,
    },
    { name: "ENABLE_TOOL_SEARCH", value: "true" },
    { name: "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL", value: "1" },
  ]);
  contribute("codex", "codex", (token) => [
    { name: "CODEX_OPENAI_BASE_URL", value: { serverPath: `${HUB_PATH}/v1` } },
    { name: "CODEX_POOL_AUTH_TOKEN", value: token },
  ]);

  const open = { auth: "none" } as const;
  const route = (method: string, pathname: string, provider: PoolProvider) =>
    bb.http.route(
      method,
      pathname,
      (request) => hub.handle(request, provider),
      open,
    );
  for (const pathname of CLAUDE_ROUTES) route("POST", pathname, "claude");
  for (const pathname of CODEX_ROUTES.split(" ")) {
    route("POST", pathname, "codex");
  }
  route("GET", "/v1/models", "codex");
  bb.http.route("HEAD", "/api/hello", () => new Response(null, OK), open);
  bb.background.service("usage", { start: (signal) => hub.start(signal) });

  const enabled = (await accounts.list()).filter((account) => account.enabled);
  if (enabled.length === 0) bb.status.needsConfiguration(NEEDS_ACCOUNT);
}
