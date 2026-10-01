import { jsonValueSchema, type JsonValue } from "@bb/domain";
import type {
  SystemEnvironmentProvider,
  SystemEnvironmentProvidersQuery,
} from "@bb/server-contract";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { listHosts } from "../db/hosts.js";
import { getProjectSource } from "../db/projects.js";
import { inspectProjectPath } from "../projects/inspect.js";
import { requireProject } from "../projects/require.js";

type Availability = SystemEnvironmentProvider["availability"];

interface EnvironmentProviderDefinition {
  id: string;
  displayName: string;
  description: string;
  icon: string;
  requires: SystemEnvironmentProvider["requires"];
  inputs: JsonValue | null;
}

const NO_REQUIREMENTS = {
  projectCheckout: false,
  gitCheckout: false,
  gitRemote: false,
  projectless: false,
};

const branchName = z.string().min(1);

export const checkoutInputsSchema = z.object({
  path: z.string().min(1).optional(),
  branch: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("existing"), name: branchName }).strict(),
      z.object({ kind: z.literal("new"), baseBranch: branchName }).strict(),
    ])
    .optional(),
});

export const worktreeInputsSchema = z
  .union([
    z.object({ kind: z.literal("existing"), path: z.string().min(1) }).strict(),
    z
      .object({
        branch: z
          .discriminatedUnion("kind", [
            z.object({ kind: z.literal("named"), name: branchName }).strict(),
            z.object({ kind: z.literal("default") }).strict(),
          ])
          .default({ kind: "default" }),
      })
      .strict(),
  ])
  .default({ branch: { kind: "default" } });

function inputsJsonSchema(schema: z.ZodType): JsonValue {
  return jsonValueSchema.parse(z.toJSONSchema(schema, { io: "input" }));
}

const ENVIRONMENT_PROVIDERS: EnvironmentProviderDefinition[] = [
  {
    id: "project-checkout",
    displayName: "Project checkout",
    description: "Work in a project checkout on this machine.",
    icon: "Laptop",
    requires: { ...NO_REQUIREMENTS, projectCheckout: true },
    inputs: inputsJsonSchema(checkoutInputsSchema),
  },
  {
    id: "git-worktree",
    displayName: "Worktree",
    description: "Create an isolated Git worktree for your changes.",
    icon: "FolderGit",
    requires: { ...NO_REQUIREMENTS, projectCheckout: true, gitCheckout: true },
    inputs: inputsJsonSchema(worktreeInputsSchema),
  },
  {
    id: "personal-workspace",
    displayName: "Personal workspace",
    description: "Create a personal directory without a project.",
    icon: "Folder",
    requires: { ...NO_REQUIREMENTS, projectless: true },
    inputs: null,
  },
];

async function gitCheckoutAvailability(
  ctx: ServerContext,
  hostId: string,
  path: string,
): Promise<Availability> {
  if (!ctx.runners.isConnected(hostId)) return null;
  const inspection = await inspectProjectPath(ctx, hostId, path);
  if (inspection === "unknown") return null;
  if (inspection.isGitRepo) return { status: "available" };
  const message = "This project checkout has no usable git branch.";
  return { status: "unavailable", message };
}

async function machineAvailability(
  ctx: ServerContext,
  definition: EnvironmentProviderDefinition,
  query: { projectId: string; hostId?: string },
): Promise<Record<string, Availability>> {
  const { db } = ctx;
  const { projectId } = query;
  const { hostId: only } = query;
  const hosts = listHosts(db, { includeCreating: false });
  const available: Record<string, Availability> = {};
  for (const { id: hostId } of hosts) {
    if (only !== undefined && hostId !== only) continue;
    const source = getProjectSource(db, projectId, { hostId });
    const { projectCheckout, gitCheckout } = definition.requires;
    if (projectCheckout && source === undefined) continue;
    available[hostId] =
      gitCheckout && source !== undefined
        ? await gitCheckoutAvailability(ctx, hostId, source.path)
        : null;
  }
  return available;
}

export async function listEnvironmentProviders(
  ctx: ServerContext,
  query: SystemEnvironmentProvidersQuery,
): Promise<SystemEnvironmentProvider[]> {
  const { hostId } = query;
  const project =
    query.projectId === undefined
      ? null
      : requireProject(ctx.db, query.projectId);
  const providers: SystemEnvironmentProvider[] = [];
  for (const definition of ENVIRONMENT_PROVIDERS) {
    const { id, requires } = definition;
    const personal = project?.kind === "personal";
    if (project !== null && requires.projectless !== personal) continue;
    const machines =
      project === null
        ? {}
        : await machineAvailability(ctx, definition, {
            projectId: project.id,
            hostId,
          });
    if (project !== null && Object.keys(machines).length === 0) continue;
    providers.push({
      machineProviderId: null,
      ...definition,
      logoUrl: null,
      pluginId: `environment-${id}`,
      acceptsEmptyInputs: true,
      availability: hostId === undefined ? null : (machines[hostId] ?? null),
      machineAvailability: machines,
    });
  }
  return providers;
}
