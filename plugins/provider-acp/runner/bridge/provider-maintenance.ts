import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type { UsageReading, usageWindowSchema } from "@bb/plugin";
import type { ProviderStatus } from "@bb/runner";
import {
  clampPercent,
  downloadedInstallerCommand,
  readCliVersion,
  resolveExecutablePath,
} from "../kit.js";
import { z } from "zod";
import { readOpenCodeGoUsage } from "./opencode-usage.js";

type UsageWindow = z.input<typeof usageWindowSchema>;

const execFileAsync = promisify(execFile);
const USAGE_FETCH_TIMEOUT_MS = 15_000;
const CURSOR_DASHBOARD_URL =
  "https://api2.cursor.sh/aiserver.v1.DashboardService";
const CURSOR_KEYCHAIN_ACCOUNT = "cursor-user";
const CURSOR_ACCESS_TOKEN_SERVICE = "cursor-access-token";
const CURSOR_INSTALL_SCRIPT_URL = "https://cursor.com/install";

function cursorAuthFilePath(): string {
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "Cursor", "auth.json");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), ".cursor", "auth.json");
  }
  const configHome =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(configHome, "cursor", "auth.json");
}

async function readKeychainAccessToken(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync(
      "security",
      [
        "find-generic-password",
        "-s",
        CURSOR_ACCESS_TOKEN_SERVICE,
        "-a",
        CURSOR_KEYCHAIN_ACCOUNT,
        "-w",
      ],
      { timeout: 10_000 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

const cursorFileCredentialsSchema = z.object({
  accessToken: z.string().min(1).nullish(),
});

async function readAccessToken(): Promise<string | null> {
  const keychain = await readKeychainAccessToken();
  if (keychain) return keychain;
  try {
    const parsed = cursorFileCredentialsSchema.safeParse(
      JSON.parse(await fs.readFile(cursorAuthFilePath(), "utf8")),
    );
    return parsed.success ? (parsed.data.accessToken ?? null) : null;
  } catch {
    return null;
  }
}

function cursorStateDatabasePath(): string {
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb",
    );
  }
  const configHome =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(
    configHome,
    "Cursor",
    "User",
    "globalStorage",
    "state.vscdb",
  );
}

function readAccountEmail(): string | null {
  const databasePath = cursorStateDatabasePath();
  if (!existsSync(databasePath)) return null;
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath);
    database.exec("PRAGMA query_only = true");
    const row = database
      .prepare("SELECT value FROM ItemTable WHERE key = ?")
      .get("cursorAuth/cachedEmail");
    const parsed = z.object({ value: z.string().email() }).safeParse(row);
    return parsed.success ? parsed.data.value : null;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

export interface AcpMaintenanceDialect {
  installer(): { command: string; args: string[]; displayCommand: string };
  signedIn(): Promise<boolean>;
  readUsage(): Promise<UsageReading>;
}

export interface AcpStatusTarget {
  providerId: string;
  maintenance: AcpMaintenanceDialect | undefined;
  command: string | null;
  missingMessage: string;
  signedOutMessage: string;
}

function installedStatus(
  target: AcpStatusTarget,
  found: {
    executablePath: string | null;
    version: string | null;
    auth: ProviderStatus["auth"];
    message: string | null;
  },
): ProviderStatus {
  return { providerId: target.providerId, installed: true, ...found };
}

function missingStatus(target: AcpStatusTarget): ProviderStatus {
  return {
    providerId: target.providerId,
    installed: false,
    executablePath: null,
    version: null,
    auth: "unknown",
    message: target.missingMessage,
    ...(target.maintenance === undefined
      ? {}
      : {
          installAction: {
            kind: "install" as const,
            command: target.maintenance.installer().displayCommand,
          },
        }),
  };
}

export async function getAcpProviderStatus(
  target: AcpStatusTarget,
): Promise<ProviderStatus> {
  const { maintenance, command } = target;
  if (command === null) {
    return installedStatus(target, {
      executablePath: null,
      version: null,
      auth: "unknown",
      message: "The ACP provider has no launch command.",
    });
  }
  const executablePath = await resolveExecutablePath(command);
  if (executablePath === null) return missingStatus(target);
  const version = await readCliVersion(command);
  if (maintenance === undefined) {
    return installedStatus(target, {
      executablePath,
      version,
      auth: "ready",
      message: null,
    });
  }
  try {
    const signedIn = await maintenance.signedIn();
    return installedStatus(target, {
      executablePath,
      version,
      auth: signedIn ? "ready" : "unauthenticated",
      message: signedIn ? null : target.signedOutMessage,
    });
  } catch (error) {
    return installedStatus(target, {
      executablePath,
      version,
      auth: "unknown",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

const cursorNonNegativeIntegerSchema = z
  .union([
    z.number().int().nonnegative(),
    z.string().regex(/^\d+$/u).transform(Number),
  ])
  .refine(Number.isSafeInteger);

const cursorUsageResponseSchema = z
  .object({
    billingCycleEnd: cursorNonNegativeIntegerSchema.nullish(),
    planUsage: z
      .object({ totalPercentUsed: z.number().nonnegative().default(0) })
      .nullish(),
    spendLimitUsage: z
      .object({
        overallLimit: cursorNonNegativeIntegerSchema.nullish(),
        overallUsed: cursorNonNegativeIntegerSchema.nullish(),
        individualLimit: cursorNonNegativeIntegerSchema.nullish(),
        individualUsed: cursorNonNegativeIntegerSchema.nullish(),
        pooledLimit: cursorNonNegativeIntegerSchema.nullish(),
        pooledUsed: cursorNonNegativeIntegerSchema.nullish(),
      })
      .nullish(),
  })
  .passthrough();

const cursorPlanResponseSchema = z
  .object({
    planInfo: z.object({ planName: z.string().min(1) }).nullish(),
  })
  .passthrough();

function normalizeUsage(
  rawUsage: unknown,
  rawPlan: unknown,
  accountEmail: string | null = null,
): UsageReading {
  const usage = cursorUsageResponseSchema.safeParse(rawUsage);
  if (!usage.success) {
    return { status: "error", message: "Cursor usage response was malformed." };
  }
  const plan = cursorPlanResponseSchema.safeParse(rawPlan);
  const resetsAt =
    usage.data.billingCycleEnd == null
      ? null
      : new Date(usage.data.billingCycleEnd).toISOString();
  const windows: UsageWindow[] = [];
  if (usage.data.planUsage?.totalPercentUsed != null) {
    windows.push({
      label: "Plan usage",
      usedPercent: clampPercent(usage.data.planUsage.totalPercentUsed),
      resetsAt,
    });
  }
  const spend = usage.data.spendLimitUsage;
  const pair =
    spend?.overallLimit != null
      ? { limit: spend.overallLimit, used: spend.overallUsed ?? 0 }
      : spend?.individualLimit != null
        ? { limit: spend.individualLimit, used: spend.individualUsed ?? 0 }
        : spend?.pooledLimit != null
          ? { limit: spend.pooledLimit, used: spend.pooledUsed ?? 0 }
          : null;
  if (pair && pair.limit > 0) {
    windows.push({
      label: "On-demand spend",
      usedPercent: clampPercent((pair.used / pair.limit) * 100),
      resetsAt,
      cost: { usedUsdCents: pair.used, limitUsdCents: pair.limit },
    });
  }
  return {
    status: "ok",
    accountEmail,
    planLabel: plan.success ? (plan.data.planInfo?.planName ?? null) : null,
    windows,
  };
}

function fetchDashboard(
  method: string,
  accessToken: string,
): Promise<Response> {
  return fetch(`${CURSOR_DASHBOARD_URL}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
      "x-cursor-client-type": "cli",
      "x-cursor-client-version": "cli-bb-provider-acp",
    },
    body: "{}",
    signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
  });
}

export async function getAcpProviderUsage(args: {
  maintenance: AcpMaintenanceDialect | undefined;
  command: string | null;
  dialectId: string;
  env: NodeJS.ProcessEnv;
}): Promise<UsageReading> {
  const readUsage =
    args.dialectId === "opencode"
      ? () => readOpenCodeGoUsage(args.env)
      : args.maintenance?.readUsage;
  if (readUsage === undefined) return null;
  if (
    args.command === null ||
    (await resolveExecutablePath(args.command)) === null
  ) {
    return { status: "not_installed" };
  }
  return readUsage();
}

export const CURSOR_ACP_MAINTENANCE: AcpMaintenanceDialect = {
  installer: () => downloadedInstallerCommand(CURSOR_INSTALL_SCRIPT_URL),
  signedIn: async () => (await readAccessToken()) !== null,
  readUsage: readCursorUsage,
};

async function readCursorUsage(): Promise<UsageReading> {
  const accessToken = await readAccessToken();
  if (!accessToken) return { status: "unauthenticated" };
  try {
    const [usageResponse, planResponse] = await Promise.all([
      fetchDashboard("GetCurrentPeriodUsage", accessToken),
      fetchDashboard("GetPlanInfo", accessToken),
    ]);
    if (usageResponse.status === 401 || planResponse.status === 401) {
      return { status: "expired" };
    }
    if (!usageResponse.ok) {
      return {
        status: "error",
        message: `Cursor usage request failed (HTTP ${usageResponse.status}).`,
      };
    }
    return normalizeUsage(
      await usageResponse.json(),
      planResponse.ok ? await planResponse.json() : {},
      readAccountEmail(),
    );
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export const __testing = {
  normalizeUsage,
};
