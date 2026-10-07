import { isAbsolute } from "node:path";
import {
  PERSONAL_PROJECT_ID,
  threadEventItemPresentationSchema,
} from "@bb/domain";
import type { PluginServerApi } from "@bb/plugin";
import { RunnerError } from "@bb/runner";
import { createThreadRequestSchema } from "@bb/server-contract";
import { actorUserId } from "../auth/actor.js";
import type { ServerContext } from "../context.js";
import { decodeEvent, lastOutput, listEvents } from "../db/event-read.js";
import { listHosts } from "../db/hosts.js";
import { listStandardProjects } from "../db/projects.js";
import { listThreadRows } from "../db/thread-read.js";
import {
  createThreadSection,
  listThreadSections,
} from "../db/thread-sections.js";

import { getUser, listUsers, toUser } from "../db/users.js";
import { hostResponse } from "../runners/hosts.js";
import { toThreadListEntries } from "../threads/thread-display.js";

export type PluginOutwardApi = Pick<
  PluginServerApi,
  "threads" | "projects" | "hosts" | "users" | "sections" | "files"
> & { requestInput: PluginServerApi["ui"]["requestInput"] };

export type PluginHostDeps = (pluginId: string) => PluginOutwardApi;

export function createPluginHostDeps(ctx: ServerContext): PluginHostDeps {
  const { db, hub, runners, threads } = ctx;
  const workspace = (threadId: string, path: string) => {
    const { hostId, path: workspacePath } = threads.workspaceOf(threadId);
    const rootPath = isAbsolute(path) ? undefined : workspacePath;
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
      list: async (query = {}) =>
        toThreadListEntries(ctx, listThreadRows(db, query)),
      stop: async (threadId) => void (await threads.stop(threadId)),
      update: (threadId, patch) => threads.update(threadId, patch),
      output: async (threadId) => lastOutput(db, threadId),
      events: async (threadId, after) =>
        listEvents(db, { threadId, after }).map(decodeEvent),
    },
    projects: { list: async () => listStandardProjects(db) },
    hosts: {
      list: async () =>
        listHosts(db, { includeCreating: false }).map((row) =>
          hostResponse(ctx, row),
        ),
    },
    users: {
      current: async () => {
        const userId = actorUserId();
        const user = userId === null ? undefined : getUser(db, userId);
        return user === undefined ? null : toUser(user);
      },
      list: async () => listUsers(db).map(toUser),
    },
    sections: {
      list: async () => listThreadSections(db),
      create: async (name) => {
        const section = createThreadSection(db, name.trim());
        hub.project(PERSONAL_PROJECT_ID, ["threads-changed"]);
        return section;
      },
    },
    files: {
      async read({ threadId, path, encoding = "utf8" }) {
        const { runner, rootPath } = workspace(threadId, path);
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
        const { runner, rootPath } = workspace(threadId, file.path);
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
      const { describeSubmission } = request;
      const form = { threadId, rendererId, title, payload, presentation };
      const origin = { pluginId, signal, describeSubmission };
      return threads.requestInput({ ...form, ...origin });
    },
  });
}
