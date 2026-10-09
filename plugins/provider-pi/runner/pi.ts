import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { PromptInput } from "@bb/domain";
import {
  RunnerError,
  type ExecutionOptions,
  type ProviderAdapter,
  type ProviderSession,
  type SessionHost,
  type SessionSpec,
  type SteerInput,
  type TurnInput,
} from "@bb/runner";
import { piModels, piThinkingLevel } from "./models.js";
import { PiTranslator } from "./pi-events.js";
import {
  PiRpc,
  PiRpcError,
  piCommand,
  spawnPi,
  type SpawnPi,
} from "./pi-rpc.js";

const run = promisify(execFile);
export const SESSION_DIR_ENV = "BB_PI_BRIDGE_SESSION_DIR";
const MISSING_CLI =
  "bb could not find the Pi CLI on this machine. Install it with `npm install -g @earendil-works/pi-coding-agent` (https://pi.dev) or set BB_PI_BRIDGE_COMMAND, then retry.";

export interface PiAdapterOptions {
  spawn?: SpawnPi;
  env?: Record<string, string | undefined>;
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function launchError(error: unknown) {
  const missing = error instanceof PiRpcError && error.spawnFailed;
  const code = missing ? "missing_executable" : "failed";
  return new RunnerError(code, missing ? MISSING_CLI : describe(error));
}

function promptText(input: PromptInput[]) {
  return input
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n\n");
}

function signature(options: ExecutionOptions) {
  return `${options.model}|${options.reasoningLevel}`;
}

class PiSession implements ProviderSession {
  readonly providerThreadId: string;
  private readonly rpc: PiRpc;
  private readonly translator: PiTranslator;
  private readonly signature: string;
  private readonly scratch: string;

  constructor(
    spec: SessionSpec,
    options: ExecutionOptions,
    private readonly host: SessionHost,
    adapter: Required<PiAdapterOptions>,
  ) {
    const env = { ...adapter.env, ...host.processEnv };
    const configured = env[SESSION_DIR_ENV]?.trim();
    const sessionDir = configured
      ? resolve(configured)
      : join(homedir(), ".bb", "pi-bridge-sessions");
    this.providerThreadId = spec.providerThreadId ?? spec.threadId;
    const key = this.providerThreadId.replace(/[^A-Za-z0-9._-]/g, "_");
    mkdirSync(sessionDir, { recursive: true });
    this.signature = signature(options);
    this.scratch = join(sessionDir, `${key}.instructions.md`);
    const args = ["--mode", "rpc"];
    args.push("--session", join(sessionDir, `${key}.jsonl`));
    args.push("--session-dir", sessionDir);
    if (spec.instructions.trim()) {
      writeFileSync(this.scratch, spec.instructions, "utf8");
      args.push("--append-system-prompt", this.scratch);
    }
    for (const dir of spec.skillDirs) args.push("--skill", dir);
    const slash = options.model.indexOf("/");
    if (slash > 0) {
      args.push("--provider", options.model.slice(0, slash));
      args.push("--model", options.model.slice(slash + 1));
    }
    args.push("--thinking", piThinkingLevel(options.reasoningLevel));
    this.translator = new PiTranslator(host.events, spec.cwd);
    const launch = piCommand(env);
    const child = adapter.spawn({
      command: launch.command,
      args: [...launch.args, ...args],
      cwd: spec.cwd,
      env: { ...host.processEnv, ...spec.env },
    });
    this.rpc = new PiRpc(child, {
      onEvent: (event) => this.translator.handle(event),
      onExit: (info) => {
        rmSync(this.scratch, { force: true });
        host.onExit(info);
      },
    });
  }

  async start() {
    try {
      await this.rpc.request({ type: "get_state" });
    } catch (error) {
      this.rpc.close();
      throw launchError(error);
    }
    this.host.events.identity(this.providerThreadId);
  }

  canApply(_spec: SessionSpec, options: ExecutionOptions) {
    return !this.rpc.exited && signature(options) === this.signature;
  }

  async startTurn({ clientRequestId, input }: TurnInput) {
    const { events } = this.host;
    events.acceptInput(clientRequestId);
    const message = promptText(input);
    const prompt = { type: "prompt", message, streamingBehavior: "followUp" };
    try {
      await this.rpc.request(prompt);
    } catch (error) {
      events.error({ message: describe(error) }, { settlesTurn: true });
    }
  }

  async steer({ clientRequestId, input, expectedTurnId }: SteerInput) {
    const turnId = this.translator.turnId;
    if (turnId === undefined || turnId !== expectedTurnId) return "stale";
    const message = promptText(input);
    await this.rpc.request({
      type: "prompt",
      message,
      streamingBehavior: "steer",
    });
    this.host.events.acceptInput(clientRequestId);
    return "steered";
  }

  async interrupt() {
    if (this.translator.turnId === undefined) return;
    this.translator.interrupted = true;
    await this.rpc.request({ type: "abort" }).catch(() => undefined);
  }

  async close() {
    this.rpc.close();
    rmSync(this.scratch, { force: true });
  }
}

export function createPiAdapter(
  options: PiAdapterOptions = {},
): ProviderAdapter {
  const adapter = {
    spawn: options.spawn ?? spawnPi,
    env: options.env ?? process.env,
  };
  return {
    id: "pi",
    approvalEnforcedBy: "provider",
    async status() {
      const launch = piCommand(adapter.env);
      const base = { providerId: "pi", executablePath: null, message: null };
      try {
        const args = [...launch.args, "--version"];
        const { stdout } = await run(launch.command, args, { timeout: 15_000 });
        const version = stdout.trim() || null;
        return { ...base, installed: true, version, auth: "unknown" };
      } catch {
        const message = MISSING_CLI;
        return {
          ...base,
          installed: false,
          version: null,
          auth: "unknown",
          message,
        };
      }
    },
    async listModels(cwd) {
      const launch = piCommand(adapter.env);
      const child = adapter.spawn({
        command: launch.command,
        args: [...launch.args, "--mode", "rpc", "--no-session"],
        cwd: cwd ?? homedir(),
        env: Object.fromEntries(
          Object.entries(adapter.env).flatMap(([k, v]) =>
            v === undefined ? [] : [[k, v]],
          ),
        ),
      });
      const rpc = new PiRpc(child, {
        onEvent: () => undefined,
        onExit: () => undefined,
      });
      try {
        return piModels(await rpc.request({ type: "get_available_models" }));
      } catch (error) {
        throw launchError(error);
      } finally {
        rpc.close();
      }
    },
    async open(spec, execution, host) {
      const session = new PiSession(spec, execution, host, adapter);
      await session.start();
      return session;
    },
  };
}
