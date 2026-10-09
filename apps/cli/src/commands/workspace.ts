import { uploadAttachment } from "../remote.js";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  confirm,
  integer,
  machineFlag,
  machineId,
  machineOrThis,
  readStdin,
  validId,
  type Call,
  type Remote,
} from "../call.js";
import { usageError, type Run } from "../engine.js";

const ENVIRONMENT_STATUSES = ["ready", "destroyed"] as const;
const MANUAL_MACHINE_PROVIDER = "manual";
const LOCAL_PATH = "local_path";

function id(c: Call, name: string): string {
  return validId(c.arg(name), `<${name}> argument`);
}

function required(c: Call, name: string): string {
  const value = c.flag(name);
  if (value !== undefined) return value;
  throw usageError(`Missing required option --${name}.`);
}

export const projectList: Run = async (c) => {
  const includePersonal = c.on("include-personal");
  const projects = await c.op(c.ops.projects.list, { includePersonal });
  const rows = projects.map(({ id, name, sources }) => {
    const places = sources.map((source) => `${source.hostId}:${source.path}`);
    return { id, name, sources: places.join(" ") };
  });
  c.rows(rows, ["id", "name", "sources"], projects);
};

export const projectShow: Run = async (c) => {
  c.out(await c.op(c.ops.projects.get, { projectId: id(c, "id") }));
};

export const projectCreate: Run = async (c) => {
  const name = required(c, "name");
  const path = resolve(c.flag("root") ?? ".");
  const hostId = await machineOrThis(c);
  const source = { type: LOCAL_PATH, hostId, path } as const;
  const project = await c.op(c.ops.projects.create, { name, source });
  c.out(project, `Project ${project.id} created (${project.name})`);
};

export const projectUpdate: Run = async (c) => {
  const change = { projectId: id(c, "id"), name: required(c, "name") };
  const project = await c.op(c.ops.projects.update, change);
  c.out(project, `Project ${project.id} renamed to ${project.name}`);
};

export const projectDelete: Run = async (c) => {
  const projectId = id(c, "id");
  await confirm(c, `Delete project ${projectId} and all of its threads?`);
  await c.op(c.ops.projects.delete, { projectId });
  c.out({ ok: true, projectId }, `Project ${projectId} deleted`);
};

export const projectSourceAdd: Run = async (c) => {
  const projectId = id(c, "projectId");
  const path = required(c, "path");
  const hostId = await machineOrThis(c);
  const { projects } = c.ops;
  const type = LOCAL_PATH;
  const added = await c.op(projects.createSource, {
    projectId,
    source: { type, hostId, path },
  });
  const target = { projectId, sourceId: added.id, type } as const;
  const source = c.on("default")
    ? await c.op(projects.updateSource, { ...target, isDefault: true })
    : added;
  c.out(source, `Source ${source.id} added to project ${projectId}`);
};

export const projectSourceUpdate: Run = async (c) => {
  const source = await c.op(c.ops.projects.updateSource, {
    projectId: id(c, "projectId"),
    sourceId: id(c, "sourceId"),
    type: LOCAL_PATH,
    path: c.flag("path"),
    isDefault: c.on("default") || undefined,
  });
  c.out(source, `Source ${source.id} updated`);
};

export const projectSourceDelete: Run = async (c) => {
  const target = { projectId: id(c, "projectId"), sourceId: id(c, "sourceId") };
  await confirm(c, `Delete project source ${target.sourceId}?`);
  await c.op(c.ops.projects.deleteSource, target);
  c.out({ ok: true, ...target }, `Source ${target.sourceId} deleted`);
};

export const projectAttachmentUpload: Run = async (c) => {
  const file = required(c, "client-file");
  const uploaded = await uploadAttachment(c, {
    projectId: id(c, "id"),
    bytes: await readFile(file),
    filename: c.flag("filename") ?? basename(file),
  });
  c.out(uploaded, uploaded.path);
};

export const envList: Run = async (c) => {
  const environments = await c.op(c.ops.environments.list, {
    projectId: c.id("project"),
    hostId: await machineFlag(c),
    status: c.choice("status", ENVIRONMENT_STATUSES),
    limit: integer(c.flag("limit"), "--limit"),
  });
  c.rows(environments, ["id", "hostId", "branchName", "status", "path"]);
};

export const envShow: Run = async (c) => {
  c.out(await c.op(c.ops.environments.get, { environmentId: id(c, "id") }));
};

export const envStatus: Run = async (c) => {
  const environmentId = id(c, "id");
  const mergeBaseBranch = c.flag("merge-base-branch");
  c.out(
    await c.op(c.ops.environments.status, { environmentId, mergeBaseBranch }),
  );
};

export const envCommit: Run = async (c) => {
  const environmentId = id(c, "id");
  const result = await c.op(c.ops.environments.runAction, {
    environmentId,
    action: "commit",
  });
  c.out(result, result.message);
};

export const envUpdate: Run = async (c) => {
  const cleared = (set: string, clear: string): string | null | undefined => {
    if (c.on(set) && c.on(clear)) {
      throw usageError(`Cannot combine --${set} with --${clear}.`);
    }
    return c.on(clear) ? null : c.flag(set);
  };
  const name = cleared("name", "clear-name");
  const base = cleared("merge-base-branch", "clear-merge-base-branch");
  const environmentId = id(c, "id");
  if (name === undefined && base === undefined) {
    throw usageError("Nothing to change; pass --name or --merge-base-branch.");
  }
  const changes =
    base === undefined
      ? { environmentId, name: name ?? null }
      : { environmentId, name, mergeBaseBranch: base };
  const environment = await c.op(c.ops.environments.update, changes);
  c.out(environment, `Environment ${environment.id} updated`);
};

export const envDelete: Run = async (c) => {
  const environmentId = id(c, "id");
  await confirm(c, `Delete environment ${environmentId} and its worktree?`);
  await c.op(c.ops.environments.delete, { environmentId });
  c.out({ ok: true, environmentId }, `Environment ${environmentId} deleted`);
};

export const machineList: Run = async (c) => {
  const [hosts, users] = await Promise.all([
    c.op(c.ops.machines.list, { includeCreating: true }),
    c.op(c.ops.users.list, {}).catch(() => []),
  ]);
  const names = new Map(users.map((user) => [user.id, user.name]));
  const rows = hosts.map((host) => ({
    ...host,
    owner: names.get(host.ownerUserId ?? "") ?? host.ownerUserId,
  }));
  c.rows(
    rows,
    ["id", "name", "status", "sharing", "owner", "lastSeenAt"],
    hosts,
  );
};

function joinInstructions(command: string, expiresAt: number): string[] {
  const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60_000));
  const next = "then start it with `bb runner run`";
  return [
    `Run this on the machine within ${minutes} minutes, ${next}:`,
    command,
  ];
}

export const machineShow: Run = async (c) => {
  const hostId = await machineId(c, c.arg("machine"));
  c.out(await c.op(c.ops.machines.get, { hostId }));
};

export const machineAdd: Run = async (c) => {
  const { machines } = c.ops;
  const created = await c.op(machines.create, {
    machineProviderId: MANUAL_MACHINE_PROVIDER,
    inputs: null,
  });
  const hostId = created.id;
  const name = c.flag("name");
  const host =
    name === undefined
      ? created
      : await c.op(machines.update, { hostId, name });
  const join = await c.op(machines.enrollmentCommand, { hostId });
  if (join === null) throw new Error(`Machine ${hostId} has no join command.`);
  const lines = joinInstructions(join.command, join.expiresAt);
  c.out({ host, ...join }, [`Machine ${hostId} added.`, ...lines]);
};

export const machineReconnect: Run = async (c) => {
  const hostId = await machineId(c, c.arg("machine"));
  const join = await c.op(c.ops.machines.createReconnectCommand, { hostId });
  c.out(join, joinInstructions(join.command, join.expiresAt));
};

export const machineRename: Run = async (c) => {
  const hostId = await machineId(c, c.arg("machine"));
  const host = await c.op(c.ops.machines.update, {
    hostId,
    name: c.arg("name"),
  });
  c.out(host, `Machine ${host.id} renamed to ${host.name}`);
};

export const machineRemove: Run = async (c) => {
  const hostId = await machineId(c, c.arg("machine"));
  await confirm(c, `Remove machine ${hostId}?`);
  await c.op(c.ops.machines.delete, { hostId });
  c.out({ ok: true, hostId }, `Machine ${hostId} removed`);
};

function setSharing(sharing: "private" | "shared"): Run {
  return async (c) => {
    const hostId = await machineId(c, c.arg("machine"));
    const host = await c.op(c.ops.machines.updateSharing, { hostId, sharing });
    c.out(host, `Machine ${host.id} is ${host.sharing}`);
  };
}

export const machineShare = setSharing("shared");
export const machineUnshare = setSharing("private");

async function variables(c: Call, change?: "set" | "unset") {
  const remote: Remote = c;
  const projectId = c.id("project");
  const current =
    projectId === undefined
      ? await remote.op(remote.ops.settings.machineEnvironment, {})
      : await remote.op(remote.ops.projects.machineEnvironment, { projectId });
  if (change === undefined) return current;
  const name = c.arg("name");
  const kept = current.variables
    .filter((variable) => variable.name !== name)
    .map(({ name: other, note }) => ({ name: other, value: null, note }));
  const stdin = change === "set" ? await readStdin() : Buffer.alloc(0);
  const value = stdin.toString("utf8").replace(/\r?\n$/u, "");
  const note = change === "set" ? (c.flag("note") ?? null) : null;
  const next = change === "set" ? [...kept, { name, value, note }] : kept;
  return projectId === undefined
    ? remote.op(remote.ops.settings.updateMachineEnvironment, {
        variables: next,
      })
    : remote.op(remote.ops.projects.updateMachineEnvironment, {
        projectId,
        variables: next,
      });
}

export const machineEnvList: Run = async (c) => {
  const list = await variables(c);
  c.rows(list.variables, ["name", "note"], list);
};

export const machineEnvSet: Run = async (c) => {
  c.out(await variables(c, "set"), `${c.arg("name")} set`);
};

export const machineEnvUnset: Run = async (c) => {
  c.out(await variables(c, "unset"), `${c.arg("name")} removed`);
};

async function routing(
  c: Call,
): Promise<{ environmentId?: string; hostId?: string }> {
  const hostId = await machineFlag(c);
  const environmentId = c.id("environment");
  if (hostId !== undefined && environmentId !== undefined) {
    throw usageError("Cannot combine --machine with --environment.");
  }
  if (environmentId !== undefined) return { environmentId };
  return hostId === undefined ? {} : { hostId };
}

export const providerList: Run = async (c) => {
  const { sessions } = c.ops;
  if (c.on("all")) {
    const keys = ["id", "displayName", "enabled", "available"] as const;
    return c.rows(await c.op(sessions.providerCatalog, {}), [...keys]);
  }
  const listed = await c.op(sessions.providers, await routing(c));
  c.rows(listed, ["id", "displayName"]);
};

export const providerModels: Run = async (c) => {
  const target = { ...(await routing(c)), providerId: c.args.providerId };
  const { models, modelLoadError } = await c.op(
    c.ops.sessions.executionOptions,
    target,
  );
  if (modelLoadError !== null) {
    const { providerId, code, detail } = modelLoadError;
    const reason = `${code}${detail === null ? "" : `: ${detail}`}`;
    console.error(`Could not load models for ${providerId} (${reason})`);
  }
  c.rows(models, ["model", "displayName", "isDefault"]);
};

function setProviderEnabled(enabled: boolean): Run {
  return async (c) => {
    const providerId = c.arg("providerId");
    const catalog = await c.op(c.ops.sessions.updateProvider, {
      providerId,
      enabled,
    });
    c.out(catalog, `${providerId} ${enabled ? "enabled" : "disabled"}`);
  };
}

export const providerEnable = setProviderEnabled(true);
export const providerDisable = setProviderEnabled(false);
