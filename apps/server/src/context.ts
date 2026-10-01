import type { Runner } from "@bb/runner";
import type { ServerConfig } from "./config.js";
import type { Db } from "./db/index.js";
import type { Environments } from "./environments/types.js";
import type { PluginHost } from "./plugins/host.js";
import type { RunnerRegistry } from "./runners/registry.js";
import type { ThreadEngine } from "./threads/engine.js";
import type { Hub } from "./ws/hub.js";

export type ServerRunner = Runner;

export interface ServerContext {
  config: ServerConfig;
  db: Db;
  hub: Hub;
  runners: RunnerRegistry<ServerRunner>;
  plugins: PluginHost;
  log: Logger;
  now: () => number;
  environments: Environments;
  threads: ThreadEngine;
}

export const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogFields = Record<string, unknown>;
type LogMethod = (message: string, fields?: LogFields) => void;
export type Logger = Record<Exclude<LogLevel, "silent">, LogMethod>;

function serializeLogValue(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return typeof value === "bigint" ? value.toString() : value;
}

export function createLogger(
  minimum: LogLevel = "info",
  write: (line: string) => void = console.log,
): Logger {
  const method =
    (level: LogLevel): LogMethod =>
    (message, fields) => {
      if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(minimum)) return;
      const entry = { time: new Date().toISOString(), level, message };
      write(JSON.stringify({ ...entry, ...fields }, serializeLogValue));
    };
  return {
    debug: method("debug"),
    info: method("info"),
    warn: method("warn"),
    error: method("error"),
  };
}
