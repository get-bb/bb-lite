import {
  PERSONAL_PROJECT_ID,
  threadEventItemPresentationSchema,
} from "@bb/domain";
import type { PluginServerApi } from "@bb/plugin";
import { RunnerError } from "@bb/runner";
import { createThreadRequestSchema } from "@bb/server-contract";
import type { ServerContext } from "../context.js";
import { lastAssistantText } from "../db/events.js";
import { listHosts } from "../db/hosts.js";
import { listStandardProjects } from "../db/projects.js";
import {
  createThreadSection,
  listThreadSections,
} from "../db/thread-sections.js";
import { ApiError } from "../http/errors.js";
import { hostResponse } from "../runners/hosts.js";

export type PluginOutwardApi = Pick<
  PluginServerApi,
  "threads" | "projects" | "hosts" | "sections" | "files"
> & { requestInput: PluginServerApi["ui"]["requestInput"] };

export type PluginHostDeps = (pluginId: string) => PluginOutwardApi;

const unavailable = (surface: string) => async (): Promise<never> => {
  const message = `bb.${surface} is not connected to the thread read side`;
  throw new ApiError(503, "unavailable", message);
};

export function createPluginHostDeps(ctx: ServerContext): PluginHostDeps {
  const { db, hub, runners, threads } = ctx;
  const workspace = (threadId: string) => {
    const { hostId, path: rootPath } = threads.workspaceOf(threadId);
    return { runner: runners.get(hostId), rootPath };
  };
  return (pluginId) => ({
    threads: {
      spawn: async (request) => {
        const origin = { origin: "plugin", originPluginId: pluginId };
        const attributed = { ...request, ...origin };
        return threads.create(createThreadRequestSchema.parse(attributed));
      },
      send: (threadId, request) => threads.send(threadId, request),
      get: async (threadId) => threads.get(threadId),
      list: unavailable("threads.list"),
      stop: async (threadId) => void (await threads.stop(threadId)),
      update: (threadId, patch) => threads.update(threadId, patch),
      output: async (threadId) => lastAssistantText(db, threadId),
      events: unavailable("threads.events"),
    },
    projects: { list: async () => listStandardProjects(db) },
    hosts: {
      list: async () =>
        listHosts(db, { includeCreating: false }).map((row) =>
          hostResponse(ctx, row),
        ),
    },
    sections: {
      list: async () => listThreadSections(db),
      create: async (name) => {
        const write = createThreadSection(db, name.trim());
        if (write.outcome !== "ok") {
          const message = "Section name already exists";
          throw new ApiError(409, "section_name_conflict", message);
        }
        hub.project(PERSONAL_PROJECT_ID, ["threads-changed"]);
        return write.result;
      },
    },
    files: {
      async read({ threadId, path, encoding = "utf8" }) {
        const { runner, rootPath } = workspace(threadId);
        const missing = (error: unknown) => {
          const absent = error instanceof RunnerError;
          if (absent && error.code === "path_not_found") return null;
          throw error;
        };
        const file = await runner.readFile({ path, rootPath }).catch(missing);
        if (file === null || !("content" in file)) return null;
        const bytes = Buffer.from(file.content, file.contentEncoding);
        return { content: bytes.toString(encoding), sha256: file.sha256 };
      },
      async write({ threadId, encoding: contentEncoding, ...file }) {
        const { runner, rootPath } = workspace(threadId);
        const options = { rootPath, contentEncoding, createParents: true };
        const result = await runner.writeFile({ ...file, ...options });
        if (result.outcome === "conflict") return { outcome: "conflict" };
        return { outcome: "written", sha256: result.sha256 };
      },
    },
    requestInput(request) {
      const { threadId, rendererId, title, payload, timeoutMs } = request;
      const timeout =
        timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
      const limits = [request.signal, timeout];
      const signal = AbortSignal.any(
        limits.filter((limit) => limit !== undefined),
      );
      const presentation = threadEventItemPresentationSchema.safeParse(
        request.presentation,
      ).data;
      const form = { threadId, rendererId, title, payload, presentation };
      return threads.requestInput({ ...form, pluginId, signal });
    },
  });
}
