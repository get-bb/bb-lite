import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { LOG_LEVELS, type LogLevel } from "./context.js";
import { newId, refuseLegacyDatabase } from "./db/index.js";

export interface ServerConfig {
  dataDir: string;
  port: number;
  bindHost: string;
  allowedHosts: string[];
  profile: string;
  appDir: string;
  cliDir: string;
  version: string;
  hostId: string;
  logLevel: LogLevel;
}

export type ServerEnv = Record<string, string | undefined>;

const DEFAULT_PORT = 48886;
const DEFAULT_BIND_HOST = "127.0.0.1";
const DEFAULT_APP_DIR = new URL("../../app/dist", import.meta.url);
const DEFAULT_CLI_DIR = new URL("../../cli", import.meta.url);
const ROOT_PACKAGE_JSON = new URL("../../../package.json", import.meta.url);

const envSchema = z.object({
  BB_DATA_DIR: z.string().min(1).optional(),
  BB_SERVER_PORT: z.coerce.number().int().min(0).max(65_535).optional(),
  BB_SERVER_BIND_HOST: z.string().min(1).optional(),
  BB_SERVER_ALLOWED_HOSTS: z.string().optional(),
  BB_PROFILE: z.string().min(1).optional(),
  BB_APP_DIR: z.string().min(1).optional(),
  BB_LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
});

export function loopbackUrl(config: ServerConfig): string {
  const host = config.bindHost === "0.0.0.0" ? "127.0.0.1" : config.bindHost;
  return `http://${host}:${config.port}`;
}

export function dataPaths(dataDir: string) {
  return {
    database: join(dataDir, "bb.db"),
    attachments: join(dataDir, "attachments"),
    threadStorage: join(dataDir, "thread-storage"),
    worktrees: join(dataDir, "worktrees"),
    plugins: join(dataDir, "plugins"),
    logs: join(dataDir, "logs"),
    agentsFile: join(dataDir, "AGENTS.md"),
    configFile: join(dataDir, "config.json"),
    connectFile: join(dataDir, "connect.json"),
    hostIdFile: join(dataDir, "host-id"),
  };
}

function prepareDataDir(dataDir: string) {
  const paths = dataPaths(dataDir);
  refuseLegacyDatabase(paths.database);
  for (const directory of [
    paths.attachments,
    paths.threadStorage,
    paths.worktrees,
    paths.plugins,
    paths.logs,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  if (!existsSync(paths.hostIdFile)) {
    writeFileSync(paths.hostIdFile, `${newId("host")}\n`, { flag: "wx" });
  }
  return z.string().trim().min(1).parse(readFileSync(paths.hostIdFile, "utf8"));
}

function readVersion() {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(ROOT_PACKAGE_JSON, "utf8"),
    );
    return z.object({ version: z.string() }).parse(manifest).version;
  } catch {
    return "0.0.0";
  }
}

function hostnames(list: string): string[] {
  const names = list.split(",").map((name) => name.trim().toLowerCase());
  return names.filter((name) => name !== "");
}

export function loadConfig(env: ServerEnv = process.env): ServerConfig {
  const parsed = envSchema.parse(env);
  const dataDir = resolve(parsed.BB_DATA_DIR ?? join(homedir(), ".bb-150k"));
  return {
    dataDir,
    port: parsed.BB_SERVER_PORT ?? DEFAULT_PORT,
    bindHost: parsed.BB_SERVER_BIND_HOST ?? DEFAULT_BIND_HOST,
    allowedHosts: hostnames(parsed.BB_SERVER_ALLOWED_HOSTS ?? ""),
    profile: parsed.BB_PROFILE ?? "default",
    appDir: resolve(parsed.BB_APP_DIR ?? fileURLToPath(DEFAULT_APP_DIR)),
    cliDir: fileURLToPath(DEFAULT_CLI_DIR),
    version: readVersion(),
    hostId: prepareDataDir(dataDir),
    logLevel: parsed.BB_LOG_LEVEL ?? "info",
  };
}
