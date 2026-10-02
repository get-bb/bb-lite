import { z } from "zod";
import { environmentSchema } from "@bb/domain";
import type { Environment, EnvironmentStatus } from "@bb/domain";
import {
  commitActionResponseSchema,
  publicApiRoutes,
  updateEnvironmentRequestSchema,
} from "@bb/server-contract";
import type * as api from "@bb/server-contract";
import { count, pick, type Http } from "../http.js";

type Abortable = { signal?: AbortSignal };

interface EnvironmentTarget extends Abortable {
  environmentId: string;
}

type Update = Required<api.UpdateEnvironmentRequest>;
export type EnvironmentUpdateArgs = { environmentId: string } & (
  | (Pick<Update, "mergeBaseBranch"> & Partial<Pick<Update, "name">>)
  | (Pick<Update, "name"> & Partial<Pick<Update, "mergeBaseBranch">>)
);

export type EnvironmentDiffArgs = api.EnvironmentDiffQuery & EnvironmentTarget;
export type EnvironmentDiffFileArgs = api.EnvironmentDiffFileQuery &
  EnvironmentTarget;

export interface EnvironmentListArgs extends Abortable {
  environmentProviderId?: string;
  hostId?: string;
  instanceKey?: string;
  limit?: number;
  offset?: number;
  path?: string;
  projectId?: string;
  status?: EnvironmentStatus;
}

export interface EnvironmentsArea {
  archiveThreads(
    args: EnvironmentTarget,
  ): Promise<api.EnvironmentArchiveThreadsResponse>;
  commit(args: EnvironmentTarget): Promise<api.CommitActionResponse>;
  diffBranches(
    args: EnvironmentTarget & api.EnvironmentDiffBranchesQuery,
  ): Promise<api.EnvironmentDiffBranchesResponse>;
  diffFile(
    args: EnvironmentDiffFileArgs,
  ): Promise<api.EnvironmentDiffFileResponse>;
  diffFiles(
    args: EnvironmentDiffArgs,
  ): Promise<api.EnvironmentDiffFilesResponse>;
  diffPatch(
    args: EnvironmentTarget & api.EnvironmentDiffPatchRequest,
  ): Promise<api.EnvironmentDiffPatchResponse>;
  get(args: EnvironmentTarget): Promise<Environment>;
  list(args?: EnvironmentListArgs): Promise<Environment[]>;
  listProviders(
    args?: Abortable & { projectId?: string; hostId?: string },
  ): Promise<api.SystemEnvironmentProvider[]>;
  delete(args: EnvironmentTarget): Promise<{ ok: true }>;
  paths(
    args: EnvironmentTarget & api.EnvironmentPathsQuery,
  ): Promise<api.WorkspacePathListResponse>;
  status(
    args: EnvironmentTarget & api.EnvironmentStatusQuery,
  ): Promise<api.EnvironmentStatusResponse>;
  update(args: EnvironmentUpdateArgs): Promise<Environment>;
}

const okResponseSchema = z.object({ ok: z.literal(true) });

function diffQuery(args: EnvironmentDiffArgs): api.EnvironmentDiffQuery {
  if (args.target === "uncommitted") return pick(args, ["target"]);
  if (args.target === "commit") return pick(args, ["target", "sha"]);
  return pick(args, ["target", "mergeBaseBranch"]);
}

function diffFileQuery(
  args: EnvironmentDiffFileArgs,
): api.EnvironmentDiffFileQuery {
  if (args.target === "uncommitted") {
    return pick(args, ["path", "side", "target"]);
  }
  if (args.target === "commit") {
    return pick(args, ["path", "sha", "side", "target"]);
  }
  return pick(args, ["mergeBaseRef", "path", "side", "target"]);
}

function listQuery(args: EnvironmentListArgs): api.ListEnvironmentsQuery {
  return {
    ...pick(args, [
      "projectId",
      "hostId",
      "environmentProviderId",
      "instanceKey",
      "status",
      "path",
    ]),
    limit: count(args.limit),
    offset: count(args.offset),
  };
}

export function createEnvironmentsArea(http: Http): EnvironmentsArea {
  const routes = publicApiRoutes.environments;
  const at = (environmentId: string) => ({ param: { id: environmentId } });
  return {
    archiveThreads: ({ environmentId }) =>
      http.json(routes.archiveThreads, at(environmentId)),
    async commit({ environmentId }) {
      const json = { action: "commit" as const };
      const input = { ...at(environmentId), json };
      const body = await http.json(routes.actions, input);
      return commitActionResponseSchema.parse(body);
    },
    diffBranches(args) {
      const query = pick(args, ["query", "limit", "selectedBranch"]);
      const input = { ...at(args.environmentId), query };
      return http.json(routes.diffBranches, input, args.signal);
    },
    diffFile(args) {
      const input = { ...at(args.environmentId), query: diffFileQuery(args) };
      return http.json(routes.diffFile, input, args.signal);
    },
    diffFiles(args) {
      const input = { ...at(args.environmentId), query: diffQuery(args) };
      return http.json(routes.diffFiles, input, args.signal);
    },
    diffPatch(args) {
      const json = pick(args, ["paths", "target"]);
      const input = { ...at(args.environmentId), json };
      return http.json(routes.diffPatch, input, args.signal);
    },
    list: (args = {}) =>
      http.json(routes.list, { query: listQuery(args) }, args.signal),
    async listProviders(args = {}) {
      const query = pick(args, ["projectId", "hostId"]);
      const route = publicApiRoutes.system.environmentProviders;
      const { providers } = await http.json(route, { query }, args.signal);
      return providers;
    },
    async delete({ environmentId }) {
      const body = await http.json(routes.delete, at(environmentId));
      return okResponseSchema.parse(body);
    },
    async get({ environmentId, signal }) {
      const body = await http.json(routes.get, at(environmentId), signal);
      return environmentSchema.parse(body);
    },
    paths(args) {
      const query = pick(args, [
        "includeDirectories",
        "includeFiles",
        "limit",
        "query",
      ]);
      const input = { ...at(args.environmentId), query };
      return http.json(routes.paths, input, args.signal);
    },
    status: ({ environmentId, mergeBaseBranch, signal }) =>
      http.json(
        routes.status,
        { ...at(environmentId), query: { mergeBaseBranch } },
        signal,
      ),
    update(args) {
      const changes = pick(args, ["mergeBaseBranch", "name"]);
      const json = updateEnvironmentRequestSchema.parse(changes);
      return http.json(routes.update, { ...at(args.environmentId), json });
    },
  };
}
