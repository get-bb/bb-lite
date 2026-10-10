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

function turnOptions(
  options: ExecutionOptions,
  envVars: Record<string, string>,
): engine.AcpExecutionOptions {
  return {
    model: options.model,
    reasoningLevel: options.reasoningLevel,
    serviceTier: options.serviceTier,
    permissionMode: options.permissionMode,
    envVars,
    sessionOptions: options.sessionOptions,
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
    private readonly env: Record<string, string>,
  ) {}

  canApply(spec: SessionSpec) {
    const live = engine.acpSessionIsLive(this.threadId);
    return live && signature(spec) === this.signature;
  }

  startTurn({ clientRequestId, input, options }: TurnInput) {
    return engine.startAcpTurn(this.threadId, {
      clientRequestId,
      input,
      options: turnOptions(options, this.env),
    });
  }

  async steer({ clientRequestId, input, options, expectedTurnId }: SteerInput) {
    if (this.host.events.activeTurnId !== expectedTurnId) return "stale";
    return engine.steerAcpTurn(this.threadId, {
      clientRequestId,
      input,
      options: turnOptions(options, this.env),
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
  return {
    id: agent.id,
    approvalEnforcedBy: "runner",
    status(): Promise<ProviderStatus> {
      return engine.acpProviderHealth(agent, {
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
        const catalog = await engine.listAcpModels(agent);
        const declared = await engine.listAcpSessionOptions(agent);
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
      const session = new AcpSession(threadId, signature(spec), host, env);
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
          agent,
          additionalWorkspaceWriteRoots: [
            ...host.writableRoots,
            host.threadStorageDir,
          ],
          threadId,
          cwd: spec.cwd,
          dynamicTools: spec.dynamicTools,
          instructions: spec.instructions,
          skillRoots: await skillRoots(spec.skillDirs),
          options: turnOptions(execution, env),
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
