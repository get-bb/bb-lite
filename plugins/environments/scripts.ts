import type { PluginServerApi } from "@bb/plugin";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_ENV_SETUP_SCRIPT_NAME as SETUP_SCRIPT,
  type Environment,
} from "@bb/domain";
import { ApiError } from "@bb/server-kit/http/errors";
import { resolveContributedEnvironment } from "@bb/server-kit/machine-environment";
import {
  step,
  type EnsureEnvironmentArgs,
} from "@bb/server-kit/environments/types";

type Progress = Pick<EnsureEnvironmentArgs, "onProgress" | "signal">;
export type Workspace = Pick<Environment, "id" | "hostId" | "projectId"> & {
  path: string;
};

const SCRIPT_TIMEOUT_MS = 15 * 60_000;

export function notReady(message: string): ApiError {
  return new ApiError(409, "environment_not_ready", message);
}

export function createLifecycleScripts(ctx: PluginServerApi) {
  const { log, now, runners } = ctx;
  const listeners = new Map<string, (line: string) => void>();
  runners.onEvent("script.output", ({ operationId, text }) => {
    const listener = listeners.get(operationId);
    if (listener === undefined) return;
    for (const line of text.replace(/\n$/u, "").split("\n")) listener(line);
  });

  async function run(
    workspace: Workspace,
    kind: "setup" | "teardown",
    onLine: (line: string) => void,
    signal?: AbortSignal,
  ) {
    const { hostId, path, projectId } = workspace;
    const runner = runners.get(hostId);
    const operationId = randomUUID();
    const cancel = (): void =>
      void runner.cancelOperation({ operationId }).catch(() => undefined);
    listeners.set(operationId, onLine);
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const env = await resolveContributedEnvironment(ctx, projectId);
      const timeoutMs = SCRIPT_TIMEOUT_MS;
      const script = { operationId, path, kind, timeoutMs, env };
      return await runner.runLifecycleScript(script);
    } finally {
      signal?.removeEventListener("abort", cancel);
      listeners.delete(operationId);
    }
  }

  async function setup(workspace: Workspace, job: Progress) {
    const { onProgress, signal } = job;
    const script = `${workspace.path}/${SETUP_SCRIPT}`;
    const runner = runners.get(workspace.hostId);
    const { existence } = await runner.pathsExist({ paths: [script] });
    if (existence[script] !== true) return;
    const startedAt = now();
    const running = `Running ${SETUP_SCRIPT}`;
    onProgress([step("setup-started", running, "started", startedAt)]);
    let lines = 0;
    const report = (text: string) => {
      lines += 1;
      const key = `setup-output-${lines}`;
      onProgress([{ type: "output", key, text, startedAt: now() }]);
    };
    const { failure } = await run(workspace, "setup", report, signal);
    signal.throwIfAborted();
    const status = failure === null ? "completed" : "failed";
    const text = `${SETUP_SCRIPT} ${failure === null ? "finished" : "failed"}`;
    const metadata = { durationMs: now() - startedAt };
    onProgress([step(`setup-${status}`, text, status, startedAt, metadata)]);
    if (failure !== null) throw notReady(failure.message);
  }

  async function teardown(workspace: Workspace) {
    const environmentId = workspace.id;
    const report = (text: string) =>
      log.info("Environment teardown output", { environmentId, text });
    const { failure } = await run(workspace, "teardown", report);
    if (failure === null) return;
    const { message } = failure;
    log.warn("Environment teardown script failed", { environmentId, message });
  }

  return { setup, teardown };
}
