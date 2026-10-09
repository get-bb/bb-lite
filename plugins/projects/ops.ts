import { git, workspaces } from "@bb/runner";
import { projects, type PluginServerApi } from "@bb/plugin";
import { PERSONAL_PROJECT_ID, type GitSourceInspection } from "@bb/domain";
import type {
  ProjectBranchesQuery,
  ProjectBranchesResponse,
} from "@bb/server-contract";
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
import type { ApiApp } from "@bb/server-kit/http/api";
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

export function implementProjects(bb: PluginServerApi): void {
  const { db, realtime: hub, runners } = bb;

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
    const { hostId, path } = requireProjectWorkspace(bb, projectId, {
      hostId: query.hostId,
    });
    const runner = runners.get(hostId);
    const search = { path, ...branchSearch(query) };
    const [source, branches] = await Promise.all([
      runner.call(git.source, { path }),
      runner.call(git.branches, search),
    ]);
    const defaultBase = defaultWorktreeBaseBranch(source);
    return { ...source, ...branches, defaultWorktreeBaseBranch: defaultBase };
  };

  const gitRemoteOf = async (hostId: string, path: string) =>
    (await inspectProjectPath(bb, hostId, path))?.remoteUrl ?? null;

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

  bb.implement(projects.list, ({ include, includePersonal }) => {
    const personal =
      includePersonal === true
        ? [store.requireProject(db, PERSONAL_PROJECT_ID)]
        : [];
    const listed = [...personal, ...store.listStandardProjects(db)];
    if (include?.split(",").includes("threads") !== true) {
      return store.withSources(db, listed);
    }
    return listProjectsWithThreads(bb, listed);
  });

  bb.implement(projects.create, async (payload) => {
    const { hostId, path } = payload.source;
    requireHost(bb, hostId);
    const gitRemoteUrl = await gitRemoteOf(hostId, path);
    const source = { hostId, path };
    const { name } = payload;
    const input = { name, source, gitRemoteUrl };
    const { projectId, created } = store.findOrCreateProject(db, input);
    if (created) {
      hub.project(projectId, ["project-created", "project-sources-changed"]);
    }
    return projectResponse(projectId);
  });

  bb.implement(projects.get, ({ projectId }) => projectResponse(projectId));

  bb.implement(projects.update, ({ projectId, name }) => {
    const { id } = store.requireStandardProject(db, projectId);
    if (name !== undefined) updateRow(db, "projects", id, { name });
    hub.project(id, ["project-updated"]);
    return projectResponse(id);
  });

  bb.implement(projects.delete, async ({ projectId }) => {
    requireOwner("Only an owner can delete a project");
    const project = store.requireProject(db, projectId);
    if (project.kind === "personal") {
      throw conflict("The personal project cannot be deleted");
    }
    await removeProject(bb, project.id);
  });

  bb.implement(
    projects.createSource,
    async ({ projectId, source: payload }) => {
      const { id } = store.requireStandardProject(db, projectId);
      if (payload.type !== "local_path") {
        throw invalidRequest(
          "Cloning a project onto a machine is not available. Add the path " +
            "of an existing checkout instead.",
        );
      }
      const { hostId, path } = payload;
      requireHost(bb, hostId);
      const source = store.addProjectSource(db, id, { hostId, path });
      hub.project(id, ["project-sources-changed"]);
      await recordGitRemote(id, hostId, path);
      return source;
    },
  );

  bb.implement(projects.updateSource, async (input) => {
    const { projectId, sourceId, path, isDefault } = input;
    const { id } = store.requireStandardProject(db, projectId);
    store.updateProjectSource(db, requireSource(id, sourceId), {
      path,
      isDefault,
    });
    hub.project(id, ["project-sources-changed"]);
    const updated = requireSource(id, sourceId);
    await recordGitRemote(id, updated.hostId, updated.path);
    return updated;
  });

  bb.implement(projects.deleteSource, ({ projectId, sourceId }) => {
    const { id } = store.requireStandardProject(db, projectId);
    store.deleteProjectSource(db, requireSource(id, sourceId));
    hub.project(id, ["project-sources-changed"]);
  });

  bb.implement(projects.copyAttachments, async (input) => {
    const target = store.requireProject(db, input.projectId);
    const source = store.requireProject(db, input.sourceProjectId);
    await copyAttachments(bb, source.id, target.id, input.paths);
  });

  bb.implement(projects.paths, ({ projectId, ...query }) => {
    const workspace = requireProjectWorkspace(bb, projectId, query);
    return searchWorkspacePaths(bb, workspace, query);
  });

  bb.implement(projects.commands, async ({ projectId, ...query }) => {
    const { hostId, path: cwd } = findProjectWorkspace(bb, projectId, query);
    const provider = findProviderDefinition(db, query.provider);
    if (provider === undefined) return { commands: [] };
    const providerId = provider.id;
    return runners.get(hostId).call(workspaces.commands, { providerId, cwd });
  });

  bb.implement(projects.branches, ({ projectId, ...query }) =>
    readBranches(projectId, query),
  );

  bb.implement(projects.branchOptions, ({ projectId, ...query }) =>
    readBranches(projectId, query),
  );
}

export function registerAttachmentRoutes(
  app: ApiApp,
  bb: PluginServerApi,
): void {
  const { db } = bb;
  const { dataDir } = bb.server;

  app.post("/projects/:projectId/attachments", async (c) => {
    const { id } = store.requireProject(db, c.req.param("projectId"));
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
    return c.json(await storeAttachment(bb, id, file), 201);
  });

  app.get("/projects/:projectId/attachments/content", async (c) => {
    const { id } = store.requireProject(db, c.req.param("projectId"));
    const wanted = c.req.query("path");
    if (wanted === undefined || wanted === "") throw invalidRequest("Required");
    const path = resolveAttachmentPath(dataDir, id, wanted);
    const response = await fileResponse(path, {
      range: c.req.header("range"),
      ifNoneMatch: c.req.header("if-none-match"),
      contentType: attachmentMimeType(path) ?? "application/octet-stream",
      cacheControl: ATTACHMENT_CACHE_CONTROL,
    });
    if (response === null) throw notFound("Attachment not found");
    return response;
  });
}
