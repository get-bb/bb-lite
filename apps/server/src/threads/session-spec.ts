import { readFile } from "node:fs/promises";
import type { DynamicTool } from "@bb/domain";
import type { SessionSpec } from "@bb/runner";
import { dataPaths } from "../config.js";
import type { ThreadRow } from "../db/threads.js";
import type { EngineContext } from "./core.js";
import { requireProviderId } from "./execution.js";
import type { ThreadExtensionContext } from "./extensions.js";

export interface SessionEnvironment {
  id: string;
  hostId: string;
  path: string;
}

const PLUGIN_INSTRUCTIONS_MAX_CHARS = 4096;

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

const UPDATE_ENVIRONMENT_DIRECTORY_INSTRUCTIONS =
  "If the user asks you to move this thread to another checkout, worktree, or directory, make sure the target directory exists, then call `update_environment_directory` with its absolute path. After it succeeds, stop work in the current turn; future turns will run in the updated environment.";

export const UPDATE_ENVIRONMENT_DIRECTORY_TOOL: DynamicTool = {
  name: "update_environment_directory",
  description:
    "Move this bb thread to a different working directory for subsequent turns. Use this when the user asks to switch to a new checkout, worktree, or local directory. The path must be an absolute existing directory on the current host. After a successful switch, stop the current turn because the running provider cwd will not change until the next turn.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Absolute path to an existing directory on the current host.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  presentation: {
    label: {
      pending: "Moving the thread directory",
      completed: "Moved the thread directory",
    },
    icon: { glyph: "FolderOpen" },
  },
};

async function readUserInstructions(dataDir: string): Promise<string | null> {
  try {
    const text = await readFile(dataPaths(dataDir).agentsFile, "utf8");
    return text.trim() === "" ? null : text.trim();
  } catch {
    return null;
  }
}

export function extensionContext(
  thread: ThreadRow,
  environment: SessionEnvironment,
  model: string,
): ThreadExtensionContext {
  return {
    threadId: thread.id,
    projectId: thread.projectId,
    providerId: thread.providerId,
    environmentId: environment.id,
    hostId: environment.hostId,
    model,
  };
}

export async function buildSessionSpec(
  ctx: EngineContext,
  thread: ThreadRow,
  environment: SessionEnvironment,
  model: string,
): Promise<SessionSpec> {
  const scope = extensionContext(thread, environment, model);
  const [tools, contributions, contributedEnv, user, workspace] =
    await Promise.all([
      ctx.extensions.agentTools(scope),
      ctx.extensions.instructions(scope),
      ctx.extensions.contributedEnv(scope),
      readUserInstructions(ctx.config.dataDir),
      ctx.environments.workspaceInstructions(environment.id),
    ]);
  const sections = [BB_INTRODUCTION, UPDATE_ENVIRONMENT_DIRECTORY_INSTRUCTIONS];
  for (const { pluginId, tool, instructions } of tools) {
    if (instructions === null) continue;
    const origin = `the BB plugin "${pluginId}" for its tool "${tool.name}"`;
    sections.push(`The following instructions come from ${origin}:`);
    sections.push(instructions);
  }
  for (const { pluginId, text, dynamic } of contributions) {
    if (text.trim() === "") continue;
    const kind = dynamic ? "dynamic instructions" : "instructions";
    sections.push(
      `The following ${kind} come from the BB plugin "${pluginId}":`,
    );
    sections.push(text.slice(0, PLUGIN_INSTRUCTIONS_MAX_CHARS));
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
  return {
    threadId: thread.id,
    providerId: requireProviderId(thread.providerId),
    cwd: environment.path,
    providerThreadId: thread.providerThreadId,
    fork: null,
    instructions: sections.join("\n\n"),
    dynamicTools: [
      UPDATE_ENVIRONMENT_DIRECTORY_TOOL,
      ...tools.map((contribution) => contribution.tool),
    ],
    env: {
      ...contributedEnv,
      BB_THREAD_ID: thread.id,
      BB_PROJECT_ID: thread.projectId,
      BB_ENVIRONMENT_ID: environment.id,
    },
    skillDirs: [],
  };
}
