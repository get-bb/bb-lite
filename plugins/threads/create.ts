import type { PluginServerApi } from "@bb/plugin";
import type {
  CreateThreadRequest,
  ParentThreadInvalidErrorDetails,
  ThreadResponse,
} from "@bb/server-contract";
import type { Environment, Project } from "@bb/domain";
import {
  environments as environmentKinds,
  machines as machineOps,
  threads,
} from "@bb/plugin";
import { actorUserId, viewerId } from "@bb/server-kit/auth/actor";
import { getEnvironment } from "@bb/server-kit/db/environments";
import type { Db } from "@bb/server-kit/db/index";
import {
  requireProject,
  setProjectExecutionDefaults,
} from "@bb/server-kit/db/projects";
import { requireThreadSection } from "@bb/server-kit/db/thread-sections";
import * as store from "@bb/server-kit/db/threads";
import type { EnvironmentIntent } from "@bb/server-kit/environments/types";
import { ApiError, invalidRequest } from "@bb/server-kit/http/errors";
import { assertHostUsable, defaultHostId } from "@bb/server-kit/runners/access";
import { dispatchMessage } from "./dispatch.js";
import type { Engine } from "./engine.js";
import { resolveCreateExecution } from "./execution.js";
import { deriveTitleFallback, type StartupContext } from "./provisioning.js";

type EnvironmentArgs = CreateThreadRequest["environment"];
type InvalidReason = ParentThreadInvalidErrorDetails["reason"];
type ProviderIntent = Extract<EnvironmentIntent, { type: "provider" }>;

const DEFAULT_BRANCH = { branch: { kind: "default" } };

function invalidParent(reason: InvalidReason) {
  const details: ParentThreadInvalidErrorDetails = {
    reason,
    subject: "parent",
  };
  const message = "Parent thread is invalid";
  return new ApiError(400, "parent_thread_invalid", message, { details });
}

export function requireValidParent(
  db: Db,
  parentThreadId: string,
  child: store.ThreadRow | null,
): store.ThreadRow {
  const parent = store.getThread(db, parentThreadId);
  if (parent === undefined) throw invalidParent("not_found");
  if (parent.archivedAt !== null) throw invalidParent("archived");
  if (parent.deletedAt !== null) throw invalidParent("deleted");
  const ancestors = store.ancestry(db, parent);
  if (child !== null && parent.id === child.id) throw invalidParent("self");
  if (child !== null && ancestors.includes(child.id)) {
    throw invalidParent("cycle");
  }
  const below = child === null ? 1 : store.subtreeDepth(db, child);
  if (ancestors.length + below > store.MAX_THREAD_HIERARCHY_DEPTH) {
    throw invalidParent("too_deep");
  }
  return parent;
}

function resolveIntent(
  ctx: PluginServerApi,
  args: EnvironmentArgs,
  project: Project,
  shared: Environment | undefined,
): EnvironmentIntent {
  const primary = defaultHostId(ctx);
  const personal = project.kind === "personal";
  const provided = (
    environmentProviderId: ProviderIntent["environmentProviderId"],
    hostId: string,
    inputs: ProviderIntent["inputs"],
  ): EnvironmentIntent => {
    if (environmentProviderId === "personal-workspace" && shared && personal) {
      return { type: "reuse", environmentId: shared.id };
    }
    const machine = null;
    return { type: "provider", environmentProviderId, hostId, inputs, machine };
  };
  switch (args.type) {
    case "reuse": {
      const environment = getEnvironment(ctx.db, args.environmentId);
      if (environment === undefined || environment.status === "destroyed") {
        const message = "Environment not found";
        throw new ApiError(404, "environment_not_found", message);
      }
      if (environment.projectId !== project.id) {
        throw invalidRequest("Environment belongs to another project.");
      }
      return { type: "reuse", environmentId: environment.id };
    }
    case "provider": {
      const id = args.environmentProviderId;
      const known = ctx.find(environmentKinds.kind, id) !== null;
      if (!known) throw invalidRequest("unknown environment provider");
      if (args.machine?.type !== "new") {
        return provided(id, args.machine?.hostId ?? primary, args.inputs);
      }
      const { machineProviderId: providerId, inputs } = args.machine;
      if (ctx.find(machineOps.provider, providerId) === null) {
        throw invalidRequest("unknown machine provider");
      }
      const machine = { providerId, inputs };
      const base = { type: "provider", environmentProviderId: id } as const;
      return { ...base, hostId: primary, inputs: args.inputs, machine };
    }
    case "host": {
      const hostId = args.hostId ?? primary;
      const { workspace } = args;
      if (workspace.type === "personal") {
        return provided("personal-workspace", hostId, null);
      }
      if (workspace.type === "managed-worktree") {
        const inputs = { branch: workspace.baseBranch };
        return provided("git-worktree", hostId, inputs);
      }
      if (workspace.path !== null) {
        const { path, branch } = workspace;
        const inputs = { path, ...(branch === undefined ? {} : { branch }) };
        return provided("project-checkout", hostId, inputs);
      }
      if (personal) return provided("personal-workspace", hostId, null);
      if (shared) return provided("git-worktree", hostId, DEFAULT_BRANCH);
      return provided("project-checkout", hostId, null);
    }
    case "project-default":
      if (personal) return provided("personal-workspace", primary, null);
      if (shared)
        return provided("git-worktree", shared.hostId, DEFAULT_BRANCH);
      return { type: "project-default", hostId: primary };
  }
}

function intentHostId(db: Db, intent: EnvironmentIntent) {
  if (intent.type !== "reuse") return intent.hostId;
  const environment = getEnvironment(db, intent.environmentId);
  if (environment === undefined) throw new Error("Environment disappeared");
  return environment.hostId;
}

export async function createThread(
  engine: Engine,
  request: CreateThreadRequest,
): Promise<ThreadResponse> {
  const { ctx } = engine;
  const { db } = ctx;
  const { projectId, sectionId, title } = request;
  const project = requireProject(db, projectId);
  if (sectionId != null) requireThreadSection(db, sectionId);
  const ownerId = request.lifecycleOwnerThreadId ?? null;
  const parent =
    request.parentThreadId === undefined
      ? null
      : requireValidParent(db, request.parentThreadId, null);
  const sharesProject = parent?.projectId === projectId;
  const shared =
    sharesProject && parent.environmentId !== null
      ? getEnvironment(db, parent.environmentId)
      : undefined;
  const intent = resolveIntent(ctx, request.environment, project, shared);
  if (intent.type === "provider") {
    const { environmentProviderId, inputs } = intent;
    const kind = ctx.find(environmentKinds.kind, environmentProviderId);
    const place = { projectId, hostId: intent.hostId };
    const refused = await kind?.validate?.(inputs, place);
    if (typeof refused === "string") throw invalidRequest(refused);
  }
  const hostId = intentHostId(db, intent);
  assertHostUsable(ctx, hostId);
  const createdByUserId = actorUserId();
  const { providerId, execution } = await resolveCreateExecution(ctx, {
    request,
    projectId,
    hostId,
    parent,
  });
  const startup: StartupContext = {
    intent,
    titleProvided: title !== undefined,
  };
  const thread = engine.commit((out) => {
    const row = store.insertThread(db, {
      projectId,
      providerId,
      ...execution,
      title: title ?? null,
      titleFallback: deriveTitleFallback(request.input),
      sectionId: sectionId ?? null,
      createdByUserId,
      viewerId: viewerId(),
      startupContext: JSON.stringify(startup),
      parentThreadId: parent?.id ?? null,
      lifecycleOwnerThreadId: ownerId,
      originPluginId: request.originPluginId ?? null,
      visibility: request.visibility ?? parent?.visibility ?? "visible",
      pinned: request.pinned === true,
    });
    out.thread(row.id, ["thread-created"], { projectId });
    out.project(projectId, ["threads-changed"]);
    const response = engine.respond(row.id);
    out.after(() => ctx.emit(threads.created, { thread: response }));
    return row;
  });
  try {
    await engine.inThread(thread.id, () =>
      dispatchMessage(engine, thread.id, {
        message: {
          input: request.input,
          execution,
          senderThreadId: null,
          actorUserId: createdByUserId,
          initiator: "user",
          systemNotice: null,
        },
        mode: "start",
        sendAt: request.sendAt ?? null,
        rows: [],
        sendNow: false,
      }),
    );
  } catch (error) {
    store.deleteThreadRow(db, thread.id);
    ctx.realtime.thread(thread.id, ["thread-deleted"], { projectId });
    throw error;
  }
  if (request.origin === "app" && request.environment.type !== "reuse") {
    setProjectExecutionDefaults(db, projectId, { providerId, ...execution });
  }
  return engine.respond(thread.id);
}
