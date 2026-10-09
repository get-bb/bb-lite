import {
  environments as environmentOps,
  sessions as sessionOps,
} from "@bb/plugin";
import { readFile } from "node:fs/promises";
import type { PluginServerApi, ThreadContext } from "@bb/plugin";
import { SERVER_URL_PLACEHOLDER, type SessionSpec } from "@bb/runner";
import { dataPaths } from "@bb/server-kit/config";
import type { SessionEnvironment } from "@bb/server-kit/services";
import type { Db } from "@bb/server-kit/db/index";
import { latestCheckpoint } from "@bb/server-kit/db/event-read";
import type { ThreadRow } from "@bb/server-kit/db/threads";
import { resolveContributedEnvironment } from "@bb/server-kit/machine-environment";
import { findProviderDefinition } from "@bb/server-kit/providers/catalog";
import { readCustomModelConfig } from "@bb/server-kit/providers/models";
import { requireProviderId } from "./execution.js";

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

function forkFrom(db: Db, thread: ThreadRow) {
  const { originKind, sourceThreadId, providerThreadId } = thread;
  const pending = originKind === "fork" && providerThreadId === null;
  if (!pending || sourceThreadId === null) return null;
  const provider = findProviderDefinition(db, thread.providerId);
  if (provider?.info.capabilities.fork !== "checkpoint") return null;
  return latestCheckpoint(db, sourceThreadId);
}

export async function buildSessionSpec(
  bb: PluginServerApi,
  thread: ThreadRow,
  environment: SessionEnvironment,
): Promise<SessionSpec> {
  const { hostId } = environment;
  const scope = pluginContext(bb.db, thread, hostId);
  const providerId = requireProviderId(bb.db, thread.providerId);
  const [plugins, pluginEnv, machineEnv, user, workspace, configured] =
    await Promise.all([
      bb
        .call(sessionOps.instructions, scope)
        .then((found) => found.map(({ text }) => text).join("\n\n")),
      bb.call(sessionOps.env, { ...scope, providerId }),
      resolveContributedEnvironment(bb, thread.projectId),
      readUserInstructions(bb.server.dataDir),
      bb.call(environmentOps.instructions, { environmentId: environment.id }),
      readCustomModelConfig(bb),
    ]);
  const dynamicTools = await bb.call(sessionOps.tools, scope);
  const skillDirs =
    hostId === bb.server.hostId
      ? await bb.call(sessionOps.skillDirs, scope)
      : [];
  const customModels = configured
    .filter((custom) => custom.providerId === providerId)
    .filter(
      ({ env, unsetEnv }) => Object.keys(env).length + unsetEnv.length > 0,
    )
    .map(({ model, env, unsetEnv }) => ({ model, env, unsetEnv }));
  const sections: string[] = [];
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
  const provider = findProviderDefinition(bb.db, providerId);
  const instructionMode = provider?.instructionMode ?? "append";
  const fork = forkFrom(bb.db, thread);
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
    dynamicTools,
    env: {
      ...machineEnv,
      ...Object.fromEntries(contributed),
      BB_THREAD_ID: thread.id,
      BB_PROJECT_ID: thread.projectId,
      BB_ENVIRONMENT_ID: environment.id,
      BB_HOST_ID: environment.hostId,
    },
    skillDirs,
    ...(customModels.length > 0 ? { customModels } : {}),
    ...(instructionMode === "replace" ? { instructionMode } : {}),
    ...(fork === null ? {} : { forkFrom: fork }),
  };
}
