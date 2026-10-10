import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  RunnerError,
  parseFrontmatter,
  type ExecutionOptions,
  type ProviderAdapter,
  type ProviderSession,
  type ProviderStatus,
  type SessionHost,
  type SessionSpec,
  type SteerInput,
  type TurnInput,
} from "@bb/runner";
import type { AcpRunnerAgent } from "../src/launch-spec.js";
import * as engine from "./engine.js";
import type { AcpSkillRoot } from "./session-params.js";

const LAUNCH_FAILURE = /^Failed to launch ACP agent/u;

function providerOptions(agent: AcpRunnerAgent, writableRoots: string[]) {
  return {
    acpLaunchSpec: agent.launch,
    additionalWorkspaceWriteRoots: writableRoots,
    ...(agent.dialect === undefined ? {} : { acpDialect: agent.dialect }),
    ...(agent.parameterizedModelPicker === true
      ? { parameterizedModelPicker: true }
      : {}),
    ...(agent.primaryModels === undefined
      ? {}
      : { primaryModels: agent.primaryModels }),
    ...(agent.reasoningProbePriorityModelIds === undefined
      ? {}
      : {
          reasoningProbePriorityModelIds: agent.reasoningProbePriorityModelIds,
        }),
  };
}

function signature(spec: SessionSpec) {
  const tools = spec.dynamicTools.map((tool) => tool.name);
  return JSON.stringify([spec.cwd, tools]);
}

async function skillRoots(dirs: string[]): Promise<AcpSkillRoot[]> {
  const roots: AcpSkillRoot[] = [];
  for (const dir of new Set(dirs)) {
    const names = await readdir(dir).catch(() => []);
    const skills: { name: string; description: string }[] = [];
    for (const name of names.sort()) {
      const file = join(dir, name, "SKILL.md");
      const content = await readFile(file, "utf8").catch(() => null);
      if (content === null) continue;
      const description = parseFrontmatter(content).description ?? "";
      skills.push({ name, description });
    }
    if (skills.length > 0) {
      roots.push({ id: dir, skillDirectoryRootPath: dir, skills });
    }
  }
  return roots;
}

function abortable<T>(work: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(new Error("ACP dynamic tool call cancelled"));
    if (signal.aborted) return cancel();
    signal.addEventListener("abort", cancel, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", cancel));
  });
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function missingCli(agent: AcpRunnerAgent) {
  const { displayName, launch, installUrl } = agent;
  const where = installUrl === undefined ? "" : ` (${installUrl})`;
  return `bb could not find \`${launch.command}\` on this machine. Install ${displayName}${where}, then retry.`;
}

function openError(agent: AcpRunnerAgent, error: unknown) {
  if (error instanceof RunnerError) return error;
  const message = describe(error);
  return LAUNCH_FAILURE.test(message)
    ? new RunnerError("missing_executable", missingCli(agent))
    : new RunnerError("failed", message);
}

class AcpSession implements ProviderSession {
  providerThreadId = "";

  constructor(
    private readonly threadId: string,
    private readonly signature: string,
    private readonly host: SessionHost,
    private readonly execution: (
      options: ExecutionOptions,
    ) => engine.AcpExecutionOptions,
  ) {}

  canApply(spec: SessionSpec) {
    const live = engine.acpSessionIsLive(this.threadId);
    return live && signature(spec) === this.signature;
  }

  startTurn({ clientRequestId, input, options }: TurnInput) {
    const request = { clientRequestId, input };
    const execution = this.execution(options);
    return engine.startAcpTurn(this.threadId, {
      ...request,
      options: execution,
    });
  }

  async steer({ clientRequestId, input, options, expectedTurnId }: SteerInput) {
    if (this.host.events.activeTurnId !== expectedTurnId) return "stale";
    const request = { clientRequestId, input };
    const execution = this.execution(options);
    return engine.steerAcpTurn(this.threadId, {
      ...request,
      options: execution,
    });
  }

  interrupt() {
    return engine.stopAcpSession(this.threadId, "stop");
  }

  close() {
    return engine.stopAcpSession(this.threadId, "release");
  }
}

export function createAcpAdapter(agent: AcpRunnerAgent): ProviderAdapter {
  const standalone = providerOptions(agent, []);
  return {
    id: agent.id,
    approvalEnforcedBy: "runner",
    status(): Promise<ProviderStatus> {
      return engine.acpProviderHealth(standalone, {
        providerId: agent.id,
        missingMessage: missingCli(agent),
        signedOutMessage:
          agent.signInCommand === undefined
            ? `Sign in to ${agent.displayName} on this machine.`
            : `Run \`${agent.signInCommand}\` on this machine to sign in.`,
      });
    },
    async listModels() {
      try {
        const catalog = await engine.listAcpModels(standalone);
        const declared = await engine.listAcpSessionOptions(standalone);
        return declared.length === 0
          ? catalog
          : {
              ...catalog,
              models: catalog.models.map((model) => ({
                ...model,
                sessionOptions: [...declared],
              })),
            };
      } catch (error) {
        throw openError(agent, error);
      }
    },
    async open(spec, execution, host) {
      const { threadId } = spec;
      const inherited = { ...host.processEnv };
      delete inherited["ELECTRON_RUN_AS_NODE"];
      const env = { ...inherited, ...host.env, BB_THREAD_ID: threadId };
      const roots = [...host.writableRoots, host.threadStorageDir];
      const options = providerOptions(agent, roots);
      const toExecution = (current: ExecutionOptions) => ({
        model: current.model,
        reasoningLevel: current.reasoningLevel,
        serviceTier: current.serviceTier,
        permissionMode: current.permissionMode,
        envVars: env,
        providerOptions: options,
        sessionOptions: current.sessionOptions,
      });
      const session = new AcpSession(
        threadId,
        signature(spec),
        host,
        toExecution,
      );
      const identify = (providerThreadId: string) => {
        if (session.providerThreadId === providerThreadId) return;
        session.providerThreadId = providerThreadId;
        host.events.identity(providerThreadId);
      };
      const turnId = () => host.events.activeTurnId;
      const output: engine.AcpSessionOutput = {
        events: host.events,
        identity: identify,
        replaced: identify,
        failed(message) {
          if (engine.acpSessionIsLive(threadId)) {
            return host.events.error({ message });
          }
          host.onExit({ message, stderrTail: "" });
        },
        callTool: (call, signal) =>
          abortable(host.callTool({ ...call, turnId: turnId() }), signal),
        requestInteraction: (payload) =>
          host.requestInteraction({ payload, turnId: turnId() }),
      };
      try {
        const opened = await engine.openAcpSession({
          threadId,
          cwd: spec.cwd,
          dynamicTools: spec.dynamicTools,
          instructions: spec.instructions,
          skillRoots: await skillRoots(spec.skillDirs),
          options: toExecution(execution),
          output,
          resumeProviderThreadId: spec.providerThreadId ?? undefined,
        });
        session.providerThreadId = opened.providerThreadId;
        return session;
      } catch (error) {
        throw openError(agent, error);
      }
    },
  };
}
