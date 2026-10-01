import { z } from "zod";
import type { ServerRunner } from "../context.js";
import {
  getEnvironment,
  insertReadyEnvironment,
  listEnvironments,
} from "../db/environments.js";
import type { Db } from "../db/index.js";
import { getProjectSource } from "../db/projects.js";
import { ApiError } from "../http/errors.js";
import type { RunnerRegistry } from "../runners/registry.js";
import type { Hub } from "../ws/hub.js";
import type {
  EnsureEnvironmentArgs,
  EnvironmentIntent,
  Environments,
} from "./types.js";

interface BasicEnvironmentDeps {
  db: Db;
  hub: Hub;
  runners: RunnerRegistry<ServerRunner>;
}

type ProvidedIntent = Exclude<EnvironmentIntent, { type: "reuse" }>;

const checkoutInputsSchema = z.object({ path: z.string().min(1) });

function unavailable(message: string): ApiError {
  return new ApiError(409, "environment_not_ready", message);
}

export function createBasicEnvironments(
  deps: BasicEnvironmentDeps,
): Environments {
  const { db } = deps;

  async function workspacePath(
    intent: ProvidedIntent,
    projectId: string,
  ): Promise<string> {
    if (intent.type === "provider") {
      const given = checkoutInputsSchema.safeParse(intent.inputs);
      if (given.success) return given.data.path;
      if (intent.environmentProviderId === "personal-workspace") {
        return (await deps.runners.get(intent.hostId).describe()).homeDir;
      }
    }
    const { hostId } = intent;
    const source = getProjectSource(db, projectId, { hostId });
    if (source !== undefined) return source.path;
    throw unavailable("This project has no checkout on the chosen machine.");
  }

  async function ensureForThread(args: EnsureEnvironmentArgs) {
    const { intent, thread } = args;
    if (intent.type === "reuse") {
      const { environmentId } = intent;
      const path = getEnvironment(db, environmentId)?.path ?? null;
      if (path === null) throw unavailable("Environment has no workspace.");
      return { environmentId, path };
    }
    const { projectId } = thread;
    const { hostId } = intent;
    const path = await workspacePath(intent, projectId);
    const located = { projectId, hostId, path };
    const [existing] = listEnvironments(db, located);
    if (existing !== undefined) return { environmentId: existing.id, path };
    const environmentProviderId =
      intent.type === "provider"
        ? intent.environmentProviderId
        : "project-checkout";
    const provided = { ...located, environmentProviderId };
    const environmentId = insertReadyEnvironment(db, provided);
    deps.hub.environment(environmentId, ["environment-created"]);
    return { environmentId, path };
  }

  return {
    ensureForThread,
    pathFor: (environmentId) => getEnvironment(db, environmentId)?.path ?? null,
    workspaceInstructions: async () => null,
    onThreadDetached: () => {},
  };
}
