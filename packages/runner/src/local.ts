import { createClaudeAdapter } from "./providers/claude.js";
import { createCodexAdapter } from "./providers/codex.js";
import { createEchoAdapter } from "./providers/echo.js";
import type { ProviderAdapter } from "./providers/provider.js";
import { Outbox } from "./sessions/outbox.js";
import {
  createSessionApi,
  type ManagedSessionApi,
  type SessionApiOptions,
} from "./sessions/session-manager.js";
import type { RunnerEventSink } from "./types.js";

export interface LocalRunnerOptions {
  dataDir: string;
  serverUrl: string;
  bbCliPath: string;
  sink: RunnerEventSink;
  adapters?: ProviderAdapter[];
  terminalIds?: SessionApiOptions["terminalIds"];
}

export type LocalSessionRunner = ManagedSessionApi & { outbox: Outbox };

export function defaultAdapters(): ProviderAdapter[] {
  return [createCodexAdapter(), createClaudeAdapter(), createEchoAdapter()];
}

export function createLocalRunner(
  options: LocalRunnerOptions,
): LocalSessionRunner {
  const outbox = new Outbox(options.sink);
  const adapters = options.adapters ?? defaultAdapters();
  const api = createSessionApi({ ...options, outbox, adapters });
  return { ...api, outbox };
}
