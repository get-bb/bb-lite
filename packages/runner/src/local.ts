import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { Caller, Op } from "@bb/plugin";
import type { z } from "zod";
import { createRunnerPlugins, runner, type RunnerPart } from "./plugins.js";
import type { ProviderAdapter } from "./providers/provider.js";
import { loginShellEnv } from "./sessions/agent-env.js";
import { Outbox } from "./sessions/outbox.js";
import { createSessionApi } from "./sessions/session-manager.js";
import type { RunnerEventSink, SessionApi } from "./types.js";
import { createWorkspaceApi } from "./workspace/index.js";
import { workspacePart } from "./workspace/part.js";

export type MachineCall = <O extends Op>(
  op: O,
  input: z.input<O["input"]>,
  options?: { timeoutMs?: number; caller?: Caller; signal?: AbortSignal },
) => Promise<z.output<O["output"]>>;

export type Runner = SessionApi & { call: MachineCall };

type OpTransport = Pick<SessionApi, "callOp" | "cancelOp">;

async function cancellable(
  { callOp, cancelOp }: OpTransport,
  sent: Parameters<SessionApi["callOp"]>[0],
  signal: AbortSignal | undefined,
): Promise<unknown> {
  if (signal === undefined) return callOp(sent);
  signal.throwIfAborted();
  const callId = randomUUID();
  const stopped = new Promise<never>((_resolve, reject) => {
    const stop = () => {
      void cancelOp({ callId }).catch(() => {});
      reject(signal.reason);
    };
    signal.addEventListener("abort", stop, { once: true });
  });
  return Promise.race([callOp({ ...sent, callId }), stopped]);
}

export function opCaller(via: OpTransport | SessionApi["callOp"]): MachineCall {
  const transport: OpTransport =
    typeof via === "function" ? { callOp: via, cancelOp: async () => {} } : via;
  return async (op, input, options = {}) => {
    const parsed: unknown = await op.input.parseAsync(input);
    const declared = (op as { timeoutMs?: number }).timeoutMs;
    const timeoutMs = options.timeoutMs ?? declared;
    const budget = timeoutMs === undefined ? {} : { timeoutMs };
    const { caller } = options;
    const from = caller === undefined ? {} : { caller };
    const sent = { name: op.name, input: parsed, ...budget, ...from };
    const result = await cancellable(transport, sent, options.signal);
    return (await op.output.parseAsync(result)) as never;
  };
}

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
  plugins.load({ id: "workspace", entry: workspacePart(workspace.api) });
  for (const part of options.parts ?? []) plugins.load(part);
  const sessions = createSessionApi({
    ...options,
    outbox,
    adapters: plugins.adapters,
    terminalIds: workspace.terminalIds,
  });
  const callOp: SessionApi["callOp"] = ({ name, input, caller, callId }) =>
    plugins.callOp(name, input, caller, callId);
  const cancelOp: SessionApi["cancelOp"] = async ({ callId }) =>
    plugins.cancelOp(callId);
  return {
    ...sessions,
    loadPlugins: (args) => plugins.sync(args.plugins),
    callOp,
    cancelOp,
    call: opCaller({ callOp, cancelOp }),
    outbox,
    shutdown: async () => {
      await sessions.shutdown();
      await workspace.dispose();
      plugins.dispose();
    },
  };
}
