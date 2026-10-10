import type {
  LogFields,
  LogLevel,
  Logger,
  OpCalls,
  PluginServerApi,
} from "@bb/plugin";
import type { Runner } from "@bb/runner";

export type ServerRunner = Runner;
export type Disposer = () => void | Promise<void>;

export type ServerServices = Pick<
  PluginServerApi,
  "server" | "db" | "realtime" | "runners" | "log" | "now"
> &
  OpCalls;

export const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;
export type { LogFields, LogLevel, Logger };
type LogMethod = Logger["info"];

function serializeLogValue(_key: string, value: unknown) {
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
