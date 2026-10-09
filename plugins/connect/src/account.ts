import * as fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import Database from "better-sqlite3";
import { z } from "zod";
import type { LoginView } from "./contract.js";
import * as hosted from "./hosted.js";

const MAX_POLL_INTERVAL_MS = 30_000;
const UNCONFIRMED =
  "getbb.dev approved the sign-in but did not confirm the new credential. " +
  "Sign in again.";
const LEGACY_CREDENTIAL = `SELECT value FROM plugin_kv
  WHERE plugin_id = 'bb-account' AND key = 'credential'`;

const httpUrl = z.url({ protocol: /^https?$/u });
const linkSchema = z.object({
  baseUrl: httpUrl,
  serverUrl: httpUrl,
  serverId: z.string().min(1),
  serverLabel: z.string().min(1),
  credential: z.string().min(1),
});
export type Link = z.infer<typeof linkSchema>;

export interface AccountOptions {
  file: string;
  provisioned?: string;
  baseUrl: string;
  clientName: string;
  warn(message: string): void;
  onChange(): void;
  pollMarginMs?: number;
  slowDownStepMs?: number;
  fetch?: typeof fetch;
}

export function shareUrl(link: Link, port: number): string {
  const base = new URL(link.baseUrl);
  return `${base.protocol}//${link.serverLabel}--${port}.${base.host}`;
}

export function legacyLink(databasePath: string): Link {
  const options = { readonly: true, fileMustExist: true };
  const database = new Database(databasePath, options);
  try {
    const value: unknown = database.prepare(LEGACY_CREDENTIAL).pluck().get();
    const error = "that database holds no bb account credential";
    const legacy: unknown = JSON.parse(z.string({ error }).parse(value));
    const stored = linkSchema.omit({ serverLabel: true }).parse(legacy);
    const [serverLabel = ""] = new URL(stored.serverUrl).hostname.split(".");
    return { ...stored, serverLabel };
  } finally {
    database.close();
  }
}

function parseLink(read: () => string): Link | null {
  try {
    return linkSchema.parse(JSON.parse(read()));
  } catch {
    return null;
  }
}

export class ConnectAccount {
  link: Link | null = null;
  login: LoginView | null = null;
  private attempt = 0;

  constructor(private readonly options: AccountOptions) {
    const { file, provisioned } = options;
    this.link = parseLink(() => fs.readFileSync(file, "utf8"));
    if (this.link === null && provisioned !== undefined) {
      this.link = parseLink(() => provisioned);
      if (this.link === null) options.warn("BB_CONNECT_LINK is not a link");
    }
  }

  adopt(link: Link | null): void {
    const { file } = this.options;
    if (link === null) {
      fs.rmSync(file, { force: true });
    } else {
      const content = `${JSON.stringify(linkSchema.parse(link), null, 2)}\n`;
      fs.writeFileSync(`${file}.tmp`, content, { mode: 0o600 });
      fs.chmodSync(`${file}.tmp`, 0o600);
      fs.renameSync(`${file}.tmp`, file);
    }
    this.link = link;
    this.options.onChange();
  }

  async startLogin(): Promise<LoginView> {
    if (this.login?.state === "pending") return this.login;
    const { baseUrl, clientName } = this.options;
    const started = await hosted.startLink(
      baseUrl,
      clientName,
      this.options.fetch,
    );
    const attempt = ++this.attempt;
    const { userCode, verificationUrl } = started;
    this.login = { state: "pending", userCode, verificationUrl, message: null };
    this.options.onChange();
    const failed = (error: unknown) => this.settle(attempt, String(error));
    this.poll(started, attempt).catch(failed);
    return this.login;
  }

  async redeem(code: string): Promise<string | null> {
    const { baseUrl, fetch: send } = this.options;
    const redeemed = await hosted.redeemCode(baseUrl, code, send);
    if (redeemed.status === "refused") return redeemed.message;
    const { credential } = redeemed;
    const profile = await hosted
      .fetchProfile(baseUrl, credential, send)
      .catch(() => null);
    if (profile === null || profile === "unauthorized") return UNCONFIRMED;
    this.attempt += 1;
    this.login = null;
    const serverUrl = profile.serverUrl.replace(/\/+$/u, "");
    this.adopt({ ...profile, baseUrl, serverUrl, credential });
    return null;
  }

  stop(): void {
    this.attempt += 1;
  }

  async logout(): Promise<{ revoked: boolean }> {
    const { link } = this;
    const disconnecting =
      link === null
        ? null
        : hosted.disconnectServer(link.serverUrl, link.credential);
    const revoked = await disconnecting?.then(
      () => true,
      (error: unknown) => {
        this.options.warn(`sign-out was not confirmed: ${String(error)}`);
        return false;
      },
    );
    this.attempt += 1;
    this.login = null;
    this.adopt(null);
    return { revoked: revoked ?? false };
  }

  async confirmRefused(credential: string): Promise<void> {
    const { link } = this;
    if (link?.credential !== credential) return;
    const profile = await hosted.fetchProfile(link.baseUrl, credential);
    if (profile !== "unauthorized" || this.link !== link) return;
    this.options.warn("getbb.dev no longer accepts this server; signed out");
    this.adopt(null);
  }

  private settle(attempt: number, message: string | null): void {
    if (attempt !== this.attempt || this.login === null) return;
    const state = message === null ? "signed-in" : "failed";
    this.login = { ...this.login, state, message };
    this.options.onChange();
  }

  private async poll(
    started: hosted.LinkStart,
    attempt: number,
  ): Promise<void> {
    const {
      baseUrl,
      pollMarginMs = 250,
      slowDownStepMs = 5_000,
    } = this.options;
    let interval = started.intervalMs;
    while (attempt === this.attempt) {
      await sleep(interval + pollMarginMs, undefined, { ref: false });
      if (attempt !== this.attempt) return;
      if (Date.now() >= started.expiresAt) {
        return this.settle(attempt, "The sign-in code expired.");
      }
      const result = await hosted
        .pollLink(baseUrl, started.deviceCode, this.options.fetch)
        .catch((error: unknown) => {
          this.options.warn(`waiting for sign-in approval: ${String(error)}`);
          return { status: "pending" } as const;
        });
      if (result.status === "refused") {
        return this.settle(attempt, result.message);
      }
      if (result.status === "slow-down") {
        interval = Math.min(interval + slowDownStepMs, MAX_POLL_INTERVAL_MS);
      }
      if (result.status !== "approved") continue;
      const { credential } = result;
      const profile = await hosted
        .fetchProfile(baseUrl, credential, this.options.fetch)
        .catch(() => null);
      if (profile === null || profile === "unauthorized") {
        return this.settle(attempt, UNCONFIRMED);
      }
      this.settle(attempt, null);
      const serverUrl = profile.serverUrl.replace(/\/+$/u, "");
      return this.adopt({ ...profile, baseUrl, serverUrl, credential });
    }
  }
}
