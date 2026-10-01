import type {
  CreateThreadRequest,
  ParentThreadInvalidErrorDetails,
  ThreadResponse,
} from "@bb/server-contract";
import {
  getEnvironmentRow,
  getProjectRow,
  threadSectionExists,
  writeProjectExecutionDefaults,
  type EnvironmentRow,
  type ProjectRow,
} from "../db/engine-lookups.js";
import { encodeJson, type Db } from "../db/index.js";
import {
  ancestorDepth,
  deleteThreadRow,
  getThread,
  insertThread,
  isAncestor,
  MAX_THREAD_HIERARCHY_DEPTH,
  subtreeDepth,
  type ThreadRow,
} from "../db/threads.js";
import {
  environmentProviderIdSchema,
  type EnvironmentIntent,
} from "../environments/types.js";
import { ApiError, invalidRequest } from "../http/errors.js";
import type { EngineContext } from "./core.js";
import type { Engine } from "./engine.js";
import { resolveCreateExecution } from "./execution.js";
import { deriveTitleFallback, type StartupContext } from "./provisioning.js";

type EnvironmentArgs = CreateThreadRequest["environment"];
type InvalidReason = ParentThreadInvalidErrorDetails["reason"];
type ProviderIntent = Extract<EnvironmentIntent, { type: "provider" }>;

const DEFAULT_BRANCH = { branch: { kind: "default" } };

function invalidParent(reason: InvalidReason): ApiError {
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
  child: ThreadRow | null,
): ThreadRow {
  const parent = getThread(db, parentThreadId);
  if (parent === undefined) throw invalidParent("not_found");
  if (parent.archivedAt !== null) throw invalidParent("archived");
  if (parent.deletedAt !== null) throw invalidParent("deleted");
  if (child !== null && parent.id === child.id) throw invalidParent("self");
  if (child !== null && isAncestor(db, child.id, parent)) {
    throw invalidParent("cycle");
  }
  const below = child === null ? 1 : subtreeDepth(db, child);
  if (ancestorDepth(db, parent) + below > MAX_THREAD_HIERARCHY_DEPTH) {
    throw invalidParent("too_deep");
  }
  return parent;
}

function resolveIntent(
  ctx: EngineContext,
  args: EnvironmentArgs,
  project: ProjectRow,
  shared: EnvironmentRow | undefined,
): EnvironmentIntent {
  const primary = ctx.config.hostId;
  const personal = project.kind === "personal";
  const provided = (
    environmentProviderId: ProviderIntent["environmentProviderId"],
    hostId: string,
    inputs: ProviderIntent["inputs"],
  ): EnvironmentIntent => {
    if (environmentProviderId === "personal-workspace" && shared && personal) {
      return { type: "reuse", environmentId: shared.id };
    }
    return { type: "provider", environmentProviderId, hostId, inputs };
  };
  switch (args.type) {
    case "reuse": {
      const environment = getEnvironmentRow(ctx.db, args.environmentId);
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
      const provider = environmentProviderIdSchema.safeParse(
        args.environmentProviderId,
      );
      if (!provider.success || args.machine?.type === "new") {
        throw invalidRequest("unknown environment provider");
      }
      const hostId = args.machine?.hostId ?? primary;
      return provided(provider.data, hostId, args.inputs);
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

function intentHostId(db: Db, intent: EnvironmentIntent): string {
  if (intent.type !== "reuse") return intent.hostId;
  const environment = getEnvironmentRow(db, intent.environmentId);
  if (environment === undefined) throw new Error("Environment disappeared");
  return environment.hostId;
}

export async function createThread(
  engine: Engine,
  request: CreateThreadRequest,
): Promise<ThreadResponse> {
  const { ctx } = engine;
  const { db, extensions } = ctx;
  const { projectId, sectionId, title } = request;
  const project = getProjectRow(db, projectId);
  if (project === undefined || project.deletedAt !== null) {
    throw new ApiError(404, "project_not_found", "Project not found");
  }
  if (request.originKind !== null || request.sourceThreadId !== undefined) {
    throw invalidRequest("Forking a thread is not supported.");
  }
  if (sectionId != null && !threadSectionExists(db, sectionId)) {
    const message = "Thread section not found";
    throw new ApiError(404, "thread_section_not_found", message);
  }
  const ownerId = request.lifecycleOwnerThreadId ?? null;
  if (ownerId !== null && getThread(db, ownerId) === undefined) {
    throw invalidRequest("lifecycleOwnerThreadId does not name a thread.");
  }
  const parent =
    request.parentThreadId === undefined
      ? null
      : requireValidParent(db, request.parentThreadId, null);
  const sharesProject = parent?.projectId === projectId;
  const shared =
    sharesProject && parent.environmentId !== null
      ? getEnvironmentRow(db, parent.environmentId)
      : undefined;
  const intent = resolveIntent(ctx, request.environment, project, shared);
  const hostId = intentHostId(db, intent);
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
    const row = insertThread(db, {
      projectId,
      providerId,
      ...execution,
      title: title ?? null,
      titleFallback: deriveTitleFallback(request.input),
      sectionId: sectionId ?? null,
      startupContext: encodeJson(startup),
      parentThreadId: parent?.id ?? null,
      lifecycleOwnerThreadId: ownerId,
      originPluginId: request.originPluginId ?? null,
      visibility: request.visibility ?? parent?.visibility ?? "visible",
      pinned: request.pinned === true,
    });
    out.thread(row.id, ["thread-created"], { projectId });
    out.project(projectId, ["threads-changed"]);
    const response = engine.respond(row);
    out.after(() => extensions.emit("thread.created", { thread: response }));
    return row;
  });
  try {
    await engine.inThread(thread.id, () =>
      engine.dispatch(thread.id, {
        message: {
          input: request.input,
          execution,
          senderThreadId: null,
          initiator: "user",
          systemNotice: null,
          origin: request.origin,
          originPluginId: request.originPluginId ?? null,
          overrides: {},
        },
        mode: "start",
        sendAt: request.sendAt ?? null,
        rows: [],
        sendNow: false,
      }),
    );
  } catch (error) {
    deleteThreadRow(db, thread.id);
    ctx.hub.thread(thread.id, ["thread-deleted"], { projectId });
    throw error;
  }
  if (request.origin === "app" && request.environment.type !== "reuse") {
    writeProjectExecutionDefaults(db, projectId, { providerId, ...execution });
  }
  return engine.respond(getThread(db, thread.id) ?? thread);
}
