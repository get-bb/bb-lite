import path from "node:path";
import type { PluginServerApi, ProviderEnvEntry } from "@bb/plugin";
import { EnvHttpProxyAgent } from "undici";
import { registerPoolCli } from "./cli.js";
import {
  ACCOUNTS_CHANGED,
  configSchema,
  HUB_PATH,
  poolRpc,
  type Account,
  type AccountAddInput,
  type PoolProvider,
  type PoolStatus,
} from "./contract.js";
import { Hub } from "./hub.js";
import { importAccount, Logins, type AccountDraft } from "./oauth.js";
import { AccountStore, HubTokens, PoolState } from "./store.js";

const NEEDS_ACCOUNT =
  "Add and enable a Claude or Codex account with `bb pool account add`.";
const OK = { status: 200 };
const CLAUDE_ROUTES = ["/v1/messages", "/v1/messages/count_tokens"];
const CODEX_ROUTES =
  "/v1/responses /v1/images/generations /v1/images/edits /v1/alpha/search";

type AccountPatch = { enabled?: boolean; priority?: number };

export interface Pool {
  logins: Logins;
  status(): Promise<PoolStatus>;
  add(input: AccountAddInput): Promise<Account>;
  update(id: string, patch: AccountPatch): Promise<Account>;
  remove(id: string): Promise<void>;
  refresh(id: string): Promise<void>;
  setRouting(provider: PoolProvider, enabled: boolean): Promise<void>;
  setThreshold(switchThreshold: number): Promise<void>;
}

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
  const changed = () => bb.realtime.publish(ACCOUNTS_CHANGED, {});
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

  const pool: Pool = {
    logins: new Logins({ ...shared, add: adopt }),
    async status() {
      const hosts = await bb.hosts.list();
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
    },
    async add({ provider, apiKey, label, priority }) {
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
    async update(id, { enabled, priority }) {
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
    },
    async remove(id) {
      if (!(await accounts.remove(id))) missing(id);
      state.setQuota(id, null);
      changed();
    },
    async refresh(id) {
      const listed = await accounts.list();
      if (!listed.some((account) => account.id === id)) missing(id);
      await hub.refreshUsage(id, true);
      changed();
    },
    async setRouting(provider, enabled) {
      await kv.set(`routing.${provider}`, enabled);
      changed();
    },
    async setThreshold(switchThreshold) {
      const next = configSchema.parse({ ...config, switchThreshold });
      await kv.set("config", next);
      config = next;
      changed();
    },
  };

  const done = async (work: Promise<unknown>) => {
    await work;
    return null;
  };
  bb.rpc.register(poolRpc, {
    status: () => pool.status(),
    "account.add": (input) => pool.add(input),
    "account.update": ({ id, ...patch }) => done(pool.update(id, patch)),
    "account.refresh": ({ id }) => done(pool.refresh(id)),
    "routing.set": (input) =>
      done(pool.setRouting(input.provider, input.enabled)),
    "config.set": (input) => done(pool.setThreshold(input.switchThreshold)),
    "login.start": ({ provider }) => pool.logins.start(provider),
    "login.complete": ({ sessionId, code }) =>
      pool.logins.complete(sessionId, code),
    "login.poll": ({ sessionId }) => pool.logins.poll(sessionId),
  });
  registerPoolCli(bb, pool);

  const contribute = (
    providerId: string,
    provider: PoolProvider,
    entries: (token: string) => ProviderEnvEntry[],
  ) =>
    bb.providers.contributeEnv(providerId, async ({ hostId }) => {
      if (hostId === null || !(await canServe(provider))) return [];
      return entries(await tokens.forHost(hostId));
    });
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
