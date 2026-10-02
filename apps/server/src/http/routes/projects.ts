import { PERSONAL_PROJECT_ID, type GitSourceInspection } from "@bb/domain";
import {
  publicApiRoutes,
  type ProjectBranchesQuery,
  type ProjectBranchesResponse,
  type ProjectResponse,
} from "@bb/server-contract";
import type { ServerContext } from "../../context.js";
import { updateRow } from "../../db/index.js";
import {
  addProjectSource,
  deleteProjectSource,
  findOrCreateProject,
  getProjectSource,
  listStandardProjects,
  reorderProject,
  setGitRemoteUrlIfMissing,
  updateProjectSource,
  withSources,
} from "../../db/projects.js";
import {
  branchSearch,
  searchWorkspacePaths,
} from "../../environments/workspace.js";
import {
  attachmentMimeType,
  copyAttachments,
  resolveAttachmentPath,
  storeAttachment,
} from "../../projects/attachments.js";
import { inspectGitRemoteUrl } from "../../projects/inspect.js";
import { removeProject } from "../../projects/remove.js";
import {
  requireProject,
  requireStandardProject,
} from "../../projects/require.js";
import {
  findProjectWorkspace,
  requireProjectWorkspace,
} from "../../projects/workspace.js";
import { findProviderDefinition } from "../../providers/catalog.js";
import { requireHost } from "../../runners/hosts.js";
import { listProjectsWithThreads } from "../../threads/thread-display.js";
import { typedApi, type ApiApp } from "../api.js";
import { ApiError, conflict, invalidRequest, notFound } from "../errors.js";
import { fileResponse } from "../range.js";

const ATTACHMENT_CACHE_CONTROL = "private, immutable, max-age=31536000";
const ATTACHMENT_FIELD = "file";

function defaultWorktreeBaseBranch(source: GitSourceInspection): string | null {
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

  const projectResponse = (projectId: string): ProjectResponse => {
    const [response] = withSources(db, [requireProject(db, projectId)]);
    if (response === undefined) throw notFound();
    return response;
  };

  const requireSource = (projectId: string, id: string) => {
    const source = getProjectSource(db, projectId, { id });
    if (source !== undefined) return source;
    throw new ApiError(404, "invalid_request", "Project source not found");
  };

  const readBranches = async (
    projectId: string,
    query: ProjectBranchesQuery,
  ): Promise<ProjectBranchesResponse> => {
    requireStandardProject(db, projectId);
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

  const recordGitRemote = async (
    projectId: string,
    hostId: string,
    path: string,
  ): Promise<void> => {
    const gitRemoteUrl = await inspectGitRemoteUrl(ctx, hostId, path);
    if (gitRemoteUrl === null) return;
    if (setGitRemoteUrlIfMissing(db, projectId, gitRemoteUrl)) {
      hub.project(projectId, ["project-updated"]);
    }
  };

  get(routes.list, (c, query) => {
    const personal =
      query.includePersonal === "true"
        ? [requireProject(db, PERSONAL_PROJECT_ID)]
        : [];
    const projects = [...personal, ...listStandardProjects(db)];
    if (query.include?.split(",").includes("threads") !== true) {
      return c.json(withSources(db, projects));
    }
    return c.json(listProjectsWithThreads(ctx, projects));
  });

  post(routes.create, async (c, payload) => {
    const { hostId, path } = payload.source;
    requireHost(ctx, hostId);
    const gitRemoteUrl = await inspectGitRemoteUrl(ctx, hostId, path);
    const source = { hostId, path };
    const { name } = payload;
    const input = { name, source, gitRemoteUrl };
    const { projectId, created } = findOrCreateProject(db, input);
    if (created) {
      hub.project(projectId, ["project-created", "project-sources-changed"]);
    }
    return c.json(projectResponse(projectId), 201);
  });

  get(routes.get, (c) => c.json(projectResponse(c.req.param("id"))));

  patch(routes.update, (c, payload) => {
    const { id } = requireStandardProject(db, c.req.param("id"));
    const { name } = payload;
    if (name !== undefined) updateRow(db, "projects", id, { name });
    hub.project(id, ["project-updated"]);
    return c.json(projectResponse(id));
  });

  patch(routes.reorder, (c, payload) => {
    const { id } = requireStandardProject(db, c.req.param("id"));
    const outcome = reorderProject(db, id, payload);
    if (outcome === "stale") throw conflict("Project order changed");
    if (outcome === "invalid") throw conflict("Project order is invalid");
    if (outcome === "reordered") hub.project(id, ["project-order-changed"]);
    return c.json(withSources(db, listStandardProjects(db)));
  });

  del(routes.delete, async (c) => {
    const project = requireProject(db, c.req.param("id"));
    if (project.kind === "personal") {
      throw conflict("The personal project cannot be deleted");
    }
    await removeProject(ctx, project.id);
    return c.json({ ok: true });
  });

  post(routes.createSource, async (c, payload) => {
    const { id } = requireStandardProject(db, c.req.param("id"));
    if (payload.type !== "local_path") {
      throw invalidRequest(
        "Cloning a project onto a machine is not available. Add the path " +
          "of an existing checkout instead.",
      );
    }
    const { hostId, path } = payload;
    requireHost(ctx, hostId);
    const source = addProjectSource(db, id, { hostId, path });
    if (source === undefined) {
      throw new ApiError(
        409,
        "project_source_host_conflict",
        "Project already has a source on this host",
      );
    }
    hub.project(id, ["project-sources-changed"]);
    await recordGitRemote(id, hostId, path);
    return c.json(source, 201);
  });

  patch(routes.updateSource, async (c, payload) => {
    const { id } = requireStandardProject(db, c.req.param("id"));
    const sourceId = c.req.param("sourceId");
    const { path, isDefault } = payload;
    updateProjectSource(db, requireSource(id, sourceId), { path, isDefault });
    hub.project(id, ["project-sources-changed"]);
    const updated = requireSource(id, sourceId);
    await recordGitRemote(id, updated.hostId, updated.path);
    return c.json(updated);
  });

  del(routes.deleteSource, (c) => {
    const { id } = requireStandardProject(db, c.req.param("id"));
    const source = requireSource(id, c.req.param("sourceId"));
    if (deleteProjectSource(db, source) === "last-source") {
      throw conflict("Cannot delete the last source of a project");
    }
    hub.project(id, ["project-sources-changed"]);
    return c.json({ ok: true });
  });

  post(routes.uploadAttachment, async (c) => {
    const { id } = requireProject(db, c.req.param("id"));
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
    const target = requireProject(db, c.req.param("id"));
    const source = requireProject(db, payload.sourceProjectId);
    await copyAttachments(ctx, source.id, target.id, payload.paths);
    return c.json({ ok: true });
  });

  get(routes.attachmentContent, async (c, query) => {
    const { id } = requireProject(db, c.req.param("id"));
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
