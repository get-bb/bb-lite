import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThreadContext } from "@bb/plugin";
import { SERVER_URL_PLACEHOLDER, type SessionSpec } from "@bb/runner";
import { dataPaths } from "../config.js";
import type { ServerContext } from "../context.js";
import type { Db } from "../db/index.js";
import type { ThreadRow } from "../db/threads.js";
import { resolveContributedEnvironment } from "../machine-environment.js";
import { findProviderDefinition } from "../providers/catalog.js";
import { readCustomModelConfig } from "../providers/models.js";
import { requireProviderId } from "./execution.js";

export interface SessionEnvironment {
  id: string;
  hostId: string;
  path: string;
}

const BB_INTRODUCTION = [
  "You are working inside bb, an agentic IDE for managing coding agents in projects, threads, and environments. The `bb` CLI is available when you need BB context or orchestration.",
  "",
  '- Prefer bare `bb` on PATH. When `BB_CLI` is set, official `bb` entrypoints re-exec to that absolute binary; you can also invoke `"$BB_CLI"` directly.',
  "- Run `bb status` to see the current project, thread, and environment.",
  "- Run `bb guide` for BB concepts and `bb guide <chapter>` for command details.",
  "- Use `bb thread ...` to inspect or wait for other BB threads. Do not spawn new threads or message other threads unless the user has explicitly asked you to do so.",
  "- Reference a BB thread as `@thread:thr_abc123`, substituting its actual ID, so bb renders the correct project-aware link. Do not construct thread URLs manually.",
  "- Use Markdown links for files, artifacts, and URLs you want the user to open; bb is a visual IDE and renders them as clickable links.",
].join("\n");

async function readUserInstructions(dataDir: string) {
  try {
    const text = await readFile(dataPaths(dataDir).agentsFile, "utf8");
    return text.trim() === "" ? null : text.trim();
  } catch {
    return null;
  }
}

export function pluginContext(
  db: Db,
  thread: ThreadRow,
  hostId: string | null,
): ThreadContext {
  const { id: threadId, projectId, providerId } = thread;
  const provider = findProviderDefinition(db, providerId);
  const providerCapabilities = provider?.info.capabilities;
  return { threadId, projectId, hostId, providerId, providerCapabilities };
}

export async function buildSessionSpec(
  ctx: ServerContext,
  thread: ThreadRow,
  environment: SessionEnvironment,
): Promise<SessionSpec> {
  const { hostId } = environment;
  const scope = pluginContext(ctx.db, thread, hostId);
  const providerId = requireProviderId(thread.providerId);
  const [plugins, pluginEnv, machineEnv, user, workspace, configured] =
    await Promise.all([
      ctx.plugins.instructionsFor(scope),
      ctx.plugins.contributedEnv(providerId, scope),
      resolveContributedEnvironment(ctx, thread.projectId),
      readUserInstructions(ctx.config.dataDir),
      ctx.environments.workspaceInstructions(environment.id),
      readCustomModelConfig(ctx),
    ]);
  const customModels = configured
    .filter((custom) => custom.providerId === providerId)
    .filter(
      ({ env, unsetEnv }) => Object.keys(env).length + unsetEnv.length > 0,
    )
    .map(({ model, env, unsetEnv }) => ({ model, env, unsetEnv }));
  const sections = [BB_INTRODUCTION];
  if (plugins !== "") {
    sections.push("The following instructions come from BB plugins:", plugins);
  }
  if (user !== null) {
    const origin = "<dataDir>/AGENTS.md";
    sections.push(`The following user instructions come from ${origin}:`, user);
  }
  if (workspace !== null) {
    const origin = ".bb/AGENTS.md";
    sections.push(`The following workspace instructions come from ${origin}:`);
    sections.push(workspace);
  }
  const contributed = pluginEnv.map(({ name, value }) => [
    name,
    typeof value === "string"
      ? value
      : SERVER_URL_PLACEHOLDER + value.serverPath,
  ]);
  return {
    threadId: thread.id,
    providerId,
    cwd: environment.path,
    providerThreadId: thread.providerThreadId,
    instructions: sections.join("\n\n"),
    dynamicTools: ctx.plugins.toolsFor(scope),
    env: {
      ...machineEnv,
      ...Object.fromEntries(contributed),
      BB_THREAD_ID: thread.id,
      BB_PROJECT_ID: thread.projectId,
      BB_ENVIRONMENT_ID: environment.id,
    },
    skillDirs:
      hostId === ctx.config.hostId
        ? [join(ctx.config.cliDir, "skills"), ...ctx.plugins.skillDirs()]
        : [],
    ...(customModels.length > 0 ? { customModels } : {}),
  };
}
