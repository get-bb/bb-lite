import { PERSONAL_PROJECT_ID, type GitSourceInspection } from "@bb/domain";
import {
  publicApiRoutes,
  type ProjectBranchesQuery,
  type ProjectBranchesResponse,
} from "@bb/server-contract";
import type { ServerContext } from "@bb/server-kit/context";
import { updateRow } from "@bb/server-kit/db/index";
import * as store from "@bb/server-kit/db/projects";
import {
  branchSearch,
  searchWorkspacePaths,
} from "@bb/server-kit/environments/workspace";
import {
  attachmentMimeType,
  copyAttachments,
  resolveAttachmentPath,
  storeAttachment,
} from "@bb/server-kit/projects/attachments";
import { removeProject } from "./remove.js";
import {
  findProjectWorkspace,
  inspectProjectPath,
  requireProjectWorkspace,
} from "@bb/server-kit/projects/workspace";
import { findProviderDefinition } from "@bb/server-kit/providers/catalog";
import { requireHost } from "@bb/server-kit/runners/hosts";
import { listProjectsWithThreads } from "@bb/server-kit/threads/thread-display";
import { typedApi, type ApiApp } from "@bb/server-kit/http/api";
import {
  ApiError,
  conflict,
  invalidRequest,
  notFound,
} from "@bb/server-kit/http/errors";
import { fileResponse } from "@bb/server-kit/http/range";
import { requireOwner } from "@bb/server-kit/http/trust";

const ATTACHMENT_CACHE_CONTROL = "private, immutable, max-age=31536000";
const ATTACHMENT_FIELD = "file";

function defaultWorktreeBaseBranch(source: GitSourceInspection) {
  const { defaultBranch, originDefaultBranch, defaultBranchRelation } = source;
  if (originDefaultBranch === null) return defaultBranch;
  const localIsAhead =
    defaultBranch !== null &&
    defaultBranchRelation !== "equal" &&
    defaultBranchRelation !== "local-behind";
  return localIsAhead ? defaultBranch : originDefaultBranch;
}

export function registerProjectRoutes(app: ApiApp, ctx: ServerContext): void {
  const { del, get, patch, post } = typedApi(app);
  const routes = publicApiRoutes.projects;
  const { db, hub, runners } = ctx;
  const { dataDir } = ctx.config;

  const projectResponse = (projectId: string) => {
    const [response] = store.withSources(db, [
      store.requireProject(db, projectId),
    ]);
    if (response === undefined) throw notFound();
    return response;
  };

  const requireSource = (projectId: string, id: string) => {
    const source = store.getProjectSource(db, projectId, { id });
    if (source !== undefined) return source;
    throw new ApiError(404, "invalid_request", "Project source not found");
  };

  const readBranches = async (
    projectId: string,
    query: ProjectBranchesQuery,
  ): Promise<ProjectBranchesResponse> => {
    store.requireStandardProject(db, projectId);
    const { hostId, path } = requireProjectWorkspace(ctx, projectId, {
      hostId: query.hostId,
    });
    const runner = runners.get(hostId);
    const search = { path, ...branchSearch(query) };
    const [source, branches] = await Promise.all([
      runner.inspectGitSource({ path }),
      runner.listBranches(search),
    ]);
    const defaultBase = defaultWorktreeBaseBranch(source);
    return { ...source, ...branches, defaultWorktreeBaseBranch: defaultBase };
  };

  const gitRemoteOf = async (hostId: string, path: string) =>
    (await inspectProjectPath(ctx, hostId, path))?.remoteUrl ?? null;

  const recordGitRemote = async (
    projectId: string,
    hostId: string,
    path: string,
  ) => {
    const gitRemoteUrl = await gitRemoteOf(hostId, path);
    if (gitRemoteUrl === null) return;
    if (store.setGitRemoteUrlIfMissing(db, projectId, gitRemoteUrl)) {
      hub.project(projectId, ["project-updated"]);
    }
  };

  get(routes.list, (c, query) => {
    const personal =
      query.includePersonal === "true"
        ? [store.requireProject(db, PERSONAL_PROJECT_ID)]
        : [];
    const projects = [...personal, ...store.listStandardProjects(db)];
    if (query.include?.split(",").includes("threads") !== true) {
      return c.json(store.withSources(db, projects));
    }
    return c.json(listProjectsWithThreads(ctx, projects));
  });

  post(routes.create, async (c, payload) => {
    const { hostId, path } = payload.source;
    requireHost(ctx, hostId);
    const gitRemoteUrl = await gitRemoteOf(hostId, path);
    const source = { hostId, path };
    const { name } = payload;
    const input = { name, source, gitRemoteUrl };
    const { projectId, created } = store.findOrCreateProject(db, input);
    if (created) {
      hub.project(projectId, ["project-created", "project-sources-changed"]);
    }
    return c.json(projectResponse(projectId), 201);
  });

  get(routes.get, (c) => c.json(projectResponse(c.req.param("id"))));

  patch(routes.update, (c, payload) => {
    const { id } = store.requireStandardProject(db, c.req.param("id"));
    const { name } = payload;
    if (name !== undefined) updateRow(db, "projects", id, { name });
    hub.project(id, ["project-updated"]);
    return c.json(projectResponse(id));
  });

  del(routes.delete, async (c) => {
    requireOwner(c, "Only an owner can delete a project");
    const project = store.requireProject(db, c.req.param("id"));
    if (project.kind === "personal") {
      throw conflict("The personal project cannot be deleted");
    }
    await removeProject(ctx, project.id);
    return c.json({ ok: true });
  });

  post(routes.createSource, async (c, payload) => {
    const { id } = store.requireStandardProject(db, c.req.param("id"));
    if (payload.type !== "local_path") {
      throw invalidRequest(
        "Cloning a project onto a machine is not available. Add the path " +
          "of an existing checkout instead.",
      );
    }
    const { hostId, path } = payload;
    requireHost(ctx, hostId);
    const source = store.addProjectSource(db, id, { hostId, path });
    hub.project(id, ["project-sources-changed"]);
    await recordGitRemote(id, hostId, path);
    return c.json(source, 201);
  });

  patch(routes.updateSource, async (c, payload) => {
    const { id } = store.requireStandardProject(db, c.req.param("id"));
    const sourceId = c.req.param("sourceId");
    const { path, isDefault } = payload;
    store.updateProjectSource(db, requireSource(id, sourceId), {
      path,
      isDefault,
    });
    hub.project(id, ["project-sources-changed"]);
    const updated = requireSource(id, sourceId);
    await recordGitRemote(id, updated.hostId, updated.path);
    return c.json(updated);
  });

  del(routes.deleteSource, (c) => {
    const { id } = store.requireStandardProject(db, c.req.param("id"));
    store.deleteProjectSource(db, requireSource(id, c.req.param("sourceId")));
    hub.project(id, ["project-sources-changed"]);
    return c.json({ ok: true });
  });

  post(routes.uploadAttachment, async (c) => {
    const { id } = store.requireProject(db, c.req.param("id"));
    const form = await c.req.formData();
    const fields = [...form.keys()];
    const file = form.get(ATTACHMENT_FIELD);
    if (fields.length !== 1 || !(file instanceof File)) {
      throw invalidRequest(
        "Attachment upload accepts exactly one multipart file field named " +
          `"${ATTACHMENT_FIELD}"`,
      );
    }
    if (file.name.trim() === "") {
      throw invalidRequest("Attachment filename is required");
    }
    return c.json(await storeAttachment(ctx, id, file), 201);
  });

  post(routes.copyAttachments, async (c, payload) => {
    const target = store.requireProject(db, c.req.param("id"));
    const source = store.requireProject(db, payload.sourceProjectId);
    await copyAttachments(ctx, source.id, target.id, payload.paths);
    return c.json({ ok: true });
  });

  get(routes.attachmentContent, async (c, query) => {
    const { id } = store.requireProject(db, c.req.param("id"));
    const path = resolveAttachmentPath(dataDir, id, query.path);
    const response = await fileResponse(path, {
      range: c.req.header("range"),
      ifNoneMatch: c.req.header("if-none-match"),
      contentType: attachmentMimeType(path) ?? "application/octet-stream",
      cacheControl: ATTACHMENT_CACHE_CONTROL,
    });
    if (response === null) throw notFound("Attachment not found");
    return response;
  });

  get(routes.paths, async (c, query) => {
    const workspace = requireProjectWorkspace(ctx, c.req.param("id"), query);
    return c.json(await searchWorkspacePaths(ctx, workspace, query));
  });

  get(routes.commands, async (c, query) => {
    const projectId = c.req.param("id");
    const { hostId, path: cwd } = findProjectWorkspace(ctx, projectId, query);
    const provider = findProviderDefinition(db, query.provider);
    if (provider === undefined) return c.json({ commands: [] });
    const providerId = provider.id;
    return c.json(await runners.get(hostId).listCommands({ providerId, cwd }));
  });

  get(routes.branches, async (c, query) =>
    c.json(await readBranches(c.req.param("id"), query)),
  );

  get(routes.branchOptions, async (c, query) =>
    c.json(await readBranches(c.req.param("id"), query)),
  );
}
