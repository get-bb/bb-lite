import { dirname } from "node:path";
import { createRunnerPlugins, runner, type RunnerPart } from "./plugins.js";
import type { ProviderAdapter } from "./providers/provider.js";
import { loginShellEnv } from "./sessions/agent-env.js";
import { Outbox } from "./sessions/outbox.js";
import { createSessionApi } from "./sessions/session-manager.js";
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
  parts?: RunnerPart[];
  log?: (message: string) => void;
}

export interface LocalRunner extends Runner {
  outbox: Outbox;
  shutdown(): Promise<void>;
}

export function createLocalRunner(options: LocalRunnerOptions): LocalRunner {
  const outbox = new Outbox(options.sink);
  const workspace = createWorkspaceApi({
    dataDir: options.dataDir,
    env: loginShellEnv(
      { BB_CLI: options.bbCliPath, BB_SERVER_URL: options.serverUrl },
      dirname(options.bbCliPath),
    ),
    sink: (event) =>
      event.kind === "script.output" ? outbox.emit(event) : options.sink(event),
  });
  const { dataDir, log } = options;
  const plugins = createRunnerPlugins({ dataDir, log, sink: options.sink });
  const given = options.adapters ?? [];
  plugins.load({
    id: "runner",
    entry(bb) {
      for (const adapter of given) bb.add(runner.provider, adapter);
    },
  });
  for (const part of options.parts ?? []) plugins.load(part);
  const sessions = createSessionApi({
    ...options,
    outbox,
    adapters: plugins.adapters,
    terminalIds: workspace.terminalIds,
  });
  return {
    ...sessions,
    ...workspace.api,
    loadPlugins: (args) => plugins.sync(args.plugins),
    callOp: ({ name, input }) => plugins.callOp(name, input),
    outbox,
    shutdown: async () => {
      await sessions.shutdown();
      await workspace.dispose();
      plugins.dispose();
    },
  };
}
