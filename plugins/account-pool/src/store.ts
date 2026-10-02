import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { PluginKv } from "@bb/plugin";
import { z } from "zod";
import {
  accountSchema,
  providerSchema,
  quotaSchema,
  type Account,
  type AccountQuota,
  type PoolProvider,
} from "./contract.js";
import { EMPTY_QUOTA } from "./limits.js";

const ACCOUNTS_KEY = "accounts:v1";
const STATE_FLUSH_DELAY_MS = 5_000;
export const AFFINITY_IDLE_TTL_MS = 30 * 60 * 1_000;
const MAX_BINDINGS = 4_096;

export const secretSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("oauth"),
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    expiresAt: z.number().int().positive().nullable(),
    idToken: z.string().min(1).optional(),
  }),
  z.object({ kind: z.literal("api-key"), apiKey: z.string().min(1) }),
]);
export type AccountSecret = z.infer<typeof secretSchema>;
export type OAuthSecret = Extract<AccountSecret, { kind: "oauth" }>;
export type NewAccount = Omit<
  Account,
  "id" | "createdAt" | "lastUsedAt" | "lastUsedHostId"
>;

const hubTokenSchema = z.object({
  hostId: z.string().regex(/^[A-Za-z0-9_-]+$/u),
  value: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  mintedAt: z.number().int().nonnegative(),
});

const stateSchema = z.object({
  quotas: z.record(z.string(), quotaSchema),
  bindings: z.array(z.tuple([z.string(), z.string(), z.number()])),
  active: z.partialRecord(providerSchema, z.string()),
});

async function writePrivate(file: string, value: unknown): Promise<void> {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

export class AccountStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly kv: PluginKv,
    private readonly directory: string,
  ) {}

  async list(): Promise<Account[]> {
    const stored = (await this.kv.get(ACCOUNTS_KEY)) ?? [];
    const accounts = z.array(accountSchema).parse(stored);
    return accounts.sort((left, right) => left.priority - right.priority);
  }

  async add(input: NewAccount, secret: AccountSecret): Promise<Account> {
    const identity = { id: randomUUID(), createdAt: Date.now() };
    const account = accountSchema.parse({ ...input, ...identity });
    await this.writeSecret(account.id, secret);
    return this.mutate((accounts) => {
      accounts.push(account);
      return account;
    });
  }

  update(id: string, patch: Partial<Account>): Promise<Account | null> {
    return this.mutate((accounts) => {
      const index = accounts.findIndex((account) => account.id === id);
      const current = accounts[index];
      if (current === undefined) return null;
      const updated = accountSchema.parse({ ...current, ...patch, id });
      accounts[index] = updated;
      return updated;
    });
  }

  remove(id: string): Promise<boolean> {
    return this.mutate(async (accounts) => {
      const index = accounts.findIndex((account) => account.id === id);
      if (index < 0) return false;
      accounts.splice(index, 1);
      await fs.rm(this.secretPath(id), { force: true });
      return true;
    });
  }

  async readSecret(id: string): Promise<AccountSecret> {
    const text = await fs.readFile(this.secretPath(id), "utf8");
    return secretSchema.parse(JSON.parse(text));
  }

  writeSecret(id: string, secret: AccountSecret): Promise<void> {
    return writePrivate(this.secretPath(id), secretSchema.parse(secret));
  }

  private secretPath(id: string): string {
    return path.join(this.directory, `account-${z.uuid().parse(id)}.json`);
  }

  private mutate<T>(
    change: (accounts: Account[]) => T | Promise<T>,
  ): Promise<T> {
    const result = this.queue.then(async () => {
      const accounts = await this.list();
      const changed = await change(accounts);
      await this.kv.set(ACCOUNTS_KEY, accounts);
      return changed;
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
}

export class HubTokens {
  private readonly tokens = new Map<string, string>();

  constructor(private readonly directory: string) {}

  async load(): Promise<void> {
    const names = await fs.readdir(this.directory).catch(() => []);
    for (const name of names) {
      if (!/^hub-token-.+\.json$/u.test(name)) continue;
      const file = path.join(this.directory, name);
      const token = hubTokenSchema.safeParse(await readJson(file)).data;
      if (token !== undefined) this.tokens.set(token.hostId, token.value);
    }
  }

  async forHost(hostId: string): Promise<string> {
    const existing = this.tokens.get(hostId);
    if (existing !== undefined) return existing;
    const value = randomBytes(32).toString("base64url");
    const token = hubTokenSchema.parse({ hostId, value, mintedAt: Date.now() });
    this.tokens.set(hostId, value);
    const file = path.join(this.directory, `hub-token-${hostId}.json`);
    await writePrivate(file, token);
    return value;
  }

  authenticate(presented: string | null): string | null {
    const given = Buffer.from(presented ?? "");
    let matched: string | null = null;
    for (const [hostId, value] of this.tokens) {
      const expected = Buffer.from(value);
      const comparable = expected.length === given.length;
      if (comparable && timingSafeEqual(expected, given)) matched = hostId;
    }
    return matched;
  }

  hostIds(): string[] {
    return [...this.tokens.keys()].sort();
  }
}

export interface Binding {
  accountId: string;
  lastUsedAt: number;
}

export class PoolState {
  readonly active = new Map<PoolProvider, string>();
  private readonly bindings = new Map<string, Binding>();
  private readonly quotas = new Map<string, AccountQuota>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    const stored = stateSchema.safeParse(await readJson(this.file)).data;
    if (stored === undefined) return;
    const cutoff = Date.now() - AFFINITY_IDLE_TTL_MS;
    for (const [id, quota] of Object.entries(stored.quotas)) {
      this.quotas.set(id, quota);
    }
    for (const [key, accountId, lastUsedAt] of stored.bindings) {
      if (lastUsedAt > cutoff)
        this.bindings.set(key, { accountId, lastUsedAt });
    }
    for (const provider of providerSchema.options) {
      const accountId = stored.active[provider];
      if (accountId !== undefined) this.active.set(provider, accountId);
    }
  }

  quota(accountId: string): AccountQuota {
    return this.quotas.get(accountId) ?? EMPTY_QUOTA;
  }

  setQuota(accountId: string, quota: AccountQuota | null): void {
    if (quota === null) this.quotas.delete(accountId);
    else this.quotas.set(accountId, quota);
    this.touch();
  }

  boundAccount(key: string | null): string | null {
    const binding = key === null ? undefined : this.bindings.get(key);
    if (binding === undefined) return null;
    const idle = Date.now() - binding.lastUsedAt;
    return idle < AFFINITY_IDLE_TTL_MS ? binding.accountId : null;
  }

  bind(key: string, accountId: string): void {
    this.bindings.delete(key);
    this.bindings.set(key, { accountId, lastUsedAt: Date.now() });
    for (const oldest of this.bindings.keys()) {
      if (this.bindings.size <= MAX_BINDINGS) break;
      this.bindings.delete(oldest);
    }
    this.touch();
  }

  touch(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => void this.flush(), STATE_FLUSH_DELAY_MS);
    this.timer.unref();
  }

  async flush(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const bindings = [...this.bindings].map(
      ([key, { accountId, lastUsedAt }]) => [key, accountId, lastUsedAt],
    );
    const quotas = Object.fromEntries(this.quotas);
    const active = Object.fromEntries(this.active);
    await writePrivate(this.file, { quotas, bindings, active });
  }
}
