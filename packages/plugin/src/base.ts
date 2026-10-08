import type { PluginVerbs } from "./kernel.js";

type MaybePromise<T> = T | Promise<T>;

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
export type LogFields = Record<string, unknown>;
type LogMethod = (message: string, fields?: LogFields) => void;
export type Logger = Record<Exclude<LogLevel, "silent">, LogMethod>;

export type Stop = () => MaybePromise<void>;

export interface PluginBase extends PluginVerbs {
  readonly pluginId: string;
  readonly log: Logger;
  onStart(start: () => MaybePromise<void | Stop>): void;
  onDispose(dispose: Stop): void;
}
