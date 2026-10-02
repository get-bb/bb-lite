import type { ProjectExecutionDefaults, ProjectSource } from "@bb/domain";
import {
  publicApiRoutes,
  uploadedPromptAttachmentSchema,
} from "@bb/server-contract";
import type * as api from "@bb/server-contract";
import { flag, pick, type Http } from "../http.js";

type Abortable = { signal?: AbortSignal };
type Ok = { ok: true };

interface ProjectTarget extends Abortable {
  projectId: string;
}

interface SourceTarget {
  projectId: string;
  sourceId: string;
}

type WorkspaceRouting =
  | { environmentId: string; hostId?: never }
  | { environmentId?: never; hostId: string }
  | { environmentId?: never; hostId?: never };

type Routed<Query> = ProjectTarget &
  WorkspaceRouting &
  Omit<Query, "environmentId" | "hostId">;

export type ProjectBranchesArgs = ProjectTarget & api.ProjectBranchesQuery;
export type ProjectBranchesResult = api.ProjectBranchesResponse;

export interface ProjectAttachmentFileLike {
  arrayBuffer(): Promise<ArrayBuffer>;
  readonly name: string;
  readonly type?: string;
}

type AttachmentBytes = ArrayBuffer | Blob | Uint8Array;

export type ProjectAttachmentUploadArgs = {
  mimeType?: string;
  projectId: string;
} & (
  | { clientFile: ProjectAttachmentFileLike; filename?: string }
  | { clientFile: AttachmentBytes; filename: string }
);

export interface ProjectsArea {
  machineEnvironment(
    args: ProjectTarget,
  ): Promise<api.ProjectMachineEnvironmentList>;
  replaceMachineEnvironment(
    args: { projectId: string } & api.MachineEnvironmentReplace,
  ): Promise<api.ProjectMachineEnvironmentList>;
  attachments: {
    copy(
      args: api.CopyProjectAttachmentsRequest & { projectId: string },
    ): Promise<void>;
    upload(
      args: ProjectAttachmentUploadArgs,
    ): Promise<api.UploadedPromptAttachment>;
  };
  branches(args: ProjectBranchesArgs): Promise<ProjectBranchesResult>;
  commands(
    args: Routed<api.ProjectCommandsQuery>,
  ): Promise<api.CommandListResponse>;
  create(args: api.CreateProjectRequest): Promise<api.ProjectResponse>;
  defaultExecutionOptions(
    args: ProjectTarget,
  ): Promise<ProjectExecutionDefaults | null>;
  delete(args: ProjectTarget): Promise<Ok>;
  get(args: ProjectTarget): Promise<api.ProjectResponse>;
  list(
    args?: Abortable & {
      include?: api.ProjectListQuery["include"];
      includePersonal?: boolean;
    },
  ): Promise<api.ProjectResponse[] | api.ProjectWithThreadsResponse[]>;
  paths(
    args: Routed<api.ProjectPathsQuery>,
  ): Promise<api.WorkspacePathListResponse>;
  promptHistory(
    args: ProjectTarget & api.PromptHistoryQuery,
  ): Promise<api.PromptHistoryResponse>;
  sources: {
    add(
      args: api.CreateProjectSourceRequest & { projectId: string },
    ): Promise<ProjectSource>;
    delete(args: SourceTarget): Promise<Ok>;
    update(
      args: api.UpdateProjectSourceRequest & SourceTarget,
    ): Promise<ProjectSource>;
  };
  update(
    args: api.UpdateProjectRequest & { projectId: string },
  ): Promise<api.ProjectResponse>;
}

function sourceJson(
  args: api.CreateProjectSourceRequest,
): api.CreateProjectSourceRequest {
  if (args.type === "local_path") return pick(args, ["hostId", "path", "type"]);
  const { remoteUrl, targetPath } = args;
  return {
    ...pick(args, ["hostId", "type"]),
    ...(remoteUrl === undefined ? {} : { remoteUrl }),
    ...(targetPath === undefined ? {} : { targetPath }),
  };
}

async function attachmentForm(args: ProjectAttachmentUploadArgs) {
  const { clientFile } = args;
  const embeddedName = "name" in clientFile ? clientFile.name : undefined;
  const filename = args.filename ?? embeddedName;
  if (typeof filename !== "string" || filename.trim().length === 0) {
    throw new Error("Project attachment filename must not be empty");
  }
  const embeddedType = "type" in clientFile ? clientFile.type : undefined;
  const mimeType =
    args.mimeType ?? (typeof embeddedType === "string" ? embeddedType : "");
  const bytes = async () => {
    if ("arrayBuffer" in clientFile) return clientFile.arrayBuffer();
    if (ArrayBuffer.isView(clientFile)) {
      return Uint8Array.from(clientFile).buffer;
    }
    return clientFile.slice(0);
  };
  const file =
    clientFile instanceof Blob && clientFile.type === mimeType
      ? clientFile
      : new Blob([await bytes()], { type: mimeType });
  const form = new FormData();
  form.set("file", file, filename);
  return form;
}

export function createProjectsArea(http: Http): ProjectsArea {
  const routes = publicApiRoutes.projects;
  const at = (projectId: string) => ({ param: { id: projectId } });
  const source = ({ projectId, sourceId }: SourceTarget) => ({
    param: { id: projectId, sourceId },
  });
  return {
    attachments: {
      async copy({ projectId, ...json }) {
        await http.send(routes.copyAttachments, { ...at(projectId), json });
      },
      async upload(args) {
        const body = await attachmentForm(args);
        const project = encodeURIComponent(args.projectId);
        const path = `/api/v1/projects/${project}/attachments`;
        const reply = await http.request(path, { body, method: "POST" });
        return uploadedPromptAttachmentSchema.parse(await reply.json());
      },
    },
    branches: ({ projectId, signal, ...query }) =>
      http.json(routes.branches, { ...at(projectId), query }, signal),
    commands: ({ projectId, signal, ...query }) =>
      http.json(routes.commands, { ...at(projectId), query }, signal),
    create: (json) => http.json(routes.create, { json }),
    async delete({ projectId }) {
      await http.send(routes.delete, at(projectId));
      return { ok: true };
    },
    defaultExecutionOptions: ({ projectId, signal }) =>
      http.json(
        routes.defaultExecutionOptions,
        { ...at(projectId), query: {} },
        signal,
      ),
    machineEnvironment: ({ projectId }) =>
      http.json(routes.machineEnvironment, at(projectId)),
    replaceMachineEnvironment: ({ projectId, variables }) =>
      http.json(routes.replaceMachineEnvironment, {
        ...at(projectId),
        json: { variables },
      }),
    get: ({ projectId, signal }) =>
      http.json(routes.get, at(projectId), signal),
    list({ include, includePersonal, signal } = {}) {
      const query = {
        ...(include === undefined ? {} : { include }),
        includePersonal: flag(includePersonal),
      };
      return http.json(routes.list, { query }, signal);
    },
    paths: ({ projectId, signal, ...query }) =>
      http.json(routes.paths, { ...at(projectId), query }, signal),
    promptHistory: ({ projectId, limit, signal }) =>
      http.json(
        routes.promptHistory,
        { ...at(projectId), query: { limit } },
        signal,
      ),
    sources: {
      add: ({ projectId, ...request }) =>
        http.json(routes.createSource, {
          ...at(projectId),
          json: sourceJson(request),
        }),
      async delete(args) {
        await http.send(routes.deleteSource, source(args));
        return { ok: true };
      },
      update: (args) =>
        http.json(routes.updateSource, {
          ...source(args),
          json: pick(args, ["isDefault", "path", "type"]),
        }),
    },
    update: ({ projectId, name }) =>
      http.json(routes.update, { ...at(projectId), json: { name } }),
  };
}
