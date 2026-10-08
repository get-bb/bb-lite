import type { PluginServerApi } from "@bb/plugin";
import { jsonValueSchema, type JsonValue } from "@bb/domain";
import type {
  SystemEnvironmentProvider,
  SystemEnvironmentProvidersQuery,
} from "@bb/server-contract";
import { environments } from "@bb/plugin";
import { z } from "zod";
import { listHosts } from "@bb/server-kit/db/hosts";
import { getProjectSource, requireProject } from "@bb/server-kit/db/projects";
import { inspectProjectPath } from "@bb/server-kit/projects/workspace";

type Availability = SystemEnvironmentProvider["availability"];

interface EnvironmentProviderDefinition {
  id: string;
  displayName: string;
  description: string;
  icon: string;
  requires: SystemEnvironmentProvider["requires"];
  inputs: JsonValue | null;
}

const CORE_PLUGIN = "environments";
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

function inputsJsonSchema(schema: z.ZodType) {
  return jsonValueSchema.parse(z.toJSONSchema(schema, { io: "input" }));
}

export const BUILTIN_ENVIRONMENT_KINDS: EnvironmentProviderDefinition[] = [
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
  bb: PluginServerApi,
  hostId: string,
  path: string,
): Promise<Availability> {
  const inspection = await inspectProjectPath(bb, hostId, path);
  if (inspection === null) return null;
  if (inspection.isGitRepo) return { status: "available" };
  const message = "This project checkout has no usable git branch.";
  return { status: "unavailable", message };
}

async function machineAvailability(
  bb: PluginServerApi,
  definition: EnvironmentProviderDefinition,
  query: { projectId: string; hostId?: string },
) {
  const { db } = bb;
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
        ? await gitCheckoutAvailability(bb, hostId, source.path)
        : null;
  }
  return available;
}

export async function listEnvironmentProviders(
  bb: PluginServerApi,
  query: SystemEnvironmentProvidersQuery,
): Promise<SystemEnvironmentProvider[]> {
  const { hostId } = query;
  const project =
    query.projectId === undefined
      ? null
      : requireProject(bb.db, query.projectId);
  const providers: SystemEnvironmentProvider[] = [];
  const kinds = bb.entries(environments.kind).map(({ plugin, item }) => {
    const core = plugin === CORE_PLUGIN;
    return {
      id: item.id,
      displayName: item.displayName,
      description: item.description ?? "",
      icon: item.icon ?? "Folder",
      requires: item.requires ?? NO_REQUIREMENTS,
      inputs: item.inputs ?? null,
      placed: item.requires !== undefined,
      pluginId: core ? `environment-${item.id}` : plugin,
    };
  });
  for (const { placed, ...definition } of kinds) {
    const { requires } = definition;
    const personal = project?.kind === "personal";
    if (placed && project !== null && requires.projectless !== personal) {
      continue;
    }
    const machines =
      project === null
        ? {}
        : await machineAvailability(bb, definition, {
            projectId: project.id,
            hostId,
          });
    if (project !== null && Object.keys(machines).length === 0) continue;
    providers.push({
      machineProviderId: null,
      ...definition,
      logoUrl: null,
      acceptsEmptyInputs: true,
      availability: hostId === undefined ? null : (machines[hostId] ?? null),
      machineAvailability: machines,
    });
  }
  return providers;
}
