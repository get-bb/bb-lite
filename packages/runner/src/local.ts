import { dirname } from "node:path";
import { createCodexAdapter } from "./providers/codex.js";
import { createEchoAdapter } from "./providers/echo.js";
import type { ProviderAdapter } from "./providers/provider.js";
import { Outbox } from "./sessions/outbox.js";
import { createSessionApi } from "./sessions/session-manager.js";
import { createLoginShellChildEnv } from "./terminals/shell-env.js";
import type { RunnerEventSink, SessionApi } from "./types.js";
import { createWorkspaceApi } from "./workspace/index.js";
import type { WorkspaceApi } from "./workspace-types.js";

export type Runner = SessionApi & WorkspaceApi;

export interface LocalRunnerOptions {
  dataDir: string;
  serverUrl: string;
  bbCliPath: string;
  sink: RunnerEventSink;
  adapters?: ProviderAdapter[];
}

export interface LocalRunner extends Runner {
  outbox: Outbox;
  shutdown(): Promise<void>;
}

export function defaultAdapters(): ProviderAdapter[] {
  return [createCodexAdapter(), createEchoAdapter()];
}

export function createLocalRunner(options: LocalRunnerOptions): LocalRunner {
  const outbox = new Outbox(options.sink);
  const workspace = createWorkspaceApi({
    dataDir: options.dataDir,
    env: createLoginShellChildEnv(
      { BB_CLI: options.bbCliPath, BB_SERVER_URL: options.serverUrl },
      dirname(options.bbCliPath),
    ),
    sink: (event) =>
      event.kind === "script.output" ? outbox.emit(event) : options.sink(event),
  });
  const sessions = createSessionApi({
    ...options,
    outbox,
    adapters: options.adapters ?? defaultAdapters(),
    terminalIds: workspace.terminalIds,
  });
  return {
    ...sessions,
    ...workspace.api,
    outbox,
    shutdown: async () => {
      await sessions.shutdown();
      await workspace.dispose();
    },
  };
}
