import { isAbsolute, resolve } from "node:path";
import {
  PERSONAL_PROJECT_ID,
  threadEventItemPresentationSchema,
} from "@bb/domain";
import {
  audit,
  files,
  interactions,
  machines,
  plugins,
  projects,
  sections,
  sessions,
  threads,
  users,
  type PluginScope,
} from "@bb/plugin";
import { RunnerError } from "@bb/runner";
import { dataPaths } from "../config.js";
import type { ServerContext } from "../context.js";
import { listAudit } from "../db/audit.js";
import { decodeEvent, lastOutput, listEvents } from "../db/event-read.js";
import { listHosts } from "../db/hosts.js";
import { listStandardProjects } from "../db/projects.js";
import { listThreadRows } from "../db/thread-read.js";
import {
  createThreadSection,
  listThreadSections,
} from "../db/thread-sections.js";
import { getUser, listUsers, toUser } from "../db/users.js";
import { readManifest, writeExternalPluginEntry } from "../plugins/manifest.js";
import { doorInstructions } from "../plugins/doors.js";
import { bindProviderCatalog } from "../providers/catalog.js";
import { hostResponse } from "../runners/hosts.js";
import { toThreadListEntries } from "../threads/thread-display.js";

export function threadReadOps(ctx: ServerContext, bb: PluginScope): void {
  const { db, hub } = ctx;
  bb.implement(threads.get, ({ threadId }) => ctx.threads.get(threadId));
  bb.implement(threads.list, (query = {}) =>
    toThreadListEntries(ctx, listThreadRows(db, query)),
  );
  bb.implement(threads.output, ({ threadId }) => lastOutput(db, threadId));
  bb.implement(threads.events, ({ threadId, after }) =>
    listEvents(db, { threadId, after }).map(decodeEvent),
  );

  bb.implement(sections.list, () => listThreadSections(db));
  bb.implement(sections.create, ({ name }) => {
    const section = createThreadSection(db, name.trim());
    hub.project(PERSONAL_PROJECT_ID, ["threads-changed"]);
    return section;
  });
}

export function interactionOps(ctx: ServerContext, bb: PluginScope): void {
  bb.implement(interactions.ask, (request, { caller }) => {
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
    const pluginId = caller.via.at(-1) ?? "core";
    const origin = { pluginId, signal, describeSubmission };
    return ctx.threads.requestInput({ ...form, ...origin });
  });
}

export function fileOps(ctx: ServerContext, bb: PluginScope): void {
  const { runners } = ctx;
  const workspace = (threadId: string, path: string) => {
    const { hostId, path: workspacePath } = ctx.threads.workspaceOf(threadId);
    const rootPath = isAbsolute(path) ? undefined : workspacePath;
    return { runner: runners.get(hostId), rootPath };
  };

  bb.implement(files.read, async (args) => {
    const { threadId, path, encoding = "utf8" } = args;
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
  });
  bb.implement(files.write, async (args) => {
    const { threadId, encoding: contentEncoding, ...file } = args;
    const { runner, rootPath } = workspace(threadId, file.path);
    const options = { rootPath, contentEncoding, createParents: true };
    const result = await runner.writeFile({ ...file, ...options });
    if (result.outcome === "conflict") return { outcome: "conflict" as const };
    return { outcome: "written" as const, sha256: result.sha256 };
  });
}

export function projectOps(ctx: ServerContext, bb: PluginScope): void {
  const { db } = ctx;
  bb.implement(projects.list, () => listStandardProjects(db));
}

export function machineOps(ctx: ServerContext, bb: PluginScope): void {
  const { db } = ctx;
  bb.implement(machines.list, () =>
    listHosts(db, { includeCreating: false }).map((row) =>
      hostResponse(ctx, row),
    ),
  );
}

export function userOps(ctx: ServerContext, bb: PluginScope): void {
  const { db } = ctx;
  bb.implement(users.current, (_input, { caller }) => {
    const user = caller.user === null ? undefined : getUser(db, caller.user);
    return user === undefined ? null : toUser(user);
  });
  bb.implement(users.list, () => listUsers(db).map(toUser));
}

export function pluginOps(ctx: ServerContext, bb: PluginScope): void {
  const { kernel } = ctx;
  const { configFile } = dataPaths(ctx.config.dataDir);
  bb.implement(plugins.inspect, () => kernel.inspect());
  bb.implement(plugins.describe, ({ id }) => ctx.plugins.locate(id));
  bb.implement(plugins.reload, ({ id }) => ctx.plugins.reload(id));
  bb.implement(plugins.install, async ({ path, watch }) => {
    const { id } = await readManifest(path);
    await writeExternalPluginEntry(configFile, path, { watch });
    await ctx.plugins.refresh(id);
    return { id: ctx.plugins.idOfDirectory(path), path: resolve(path) };
  });
  bb.implement(plugins.uninstall, async ({ path }) => {
    const id = ctx.plugins.idOfDirectory(path);
    await writeExternalPluginEntry(configFile, path, null);
    if (id === null) await ctx.plugins.reload();
    else await ctx.plugins.refresh(id);
  });
}

export function sessionOps(ctx: ServerContext, bb: PluginScope): void {
  const { db, kernel } = ctx;
  bindProviderCatalog(db, kernel);
  bb.implement(sessions.instructions, (context) =>
    doorInstructions(kernel, context),
  );
  bb.implement(sessions.env, () => []);
}

export function auditOps(ctx: ServerContext, bb: PluginScope): void {
  const { db } = ctx;
  bb.implement(audit.list, ({ user, thread, ...query }, { caller }) => {
    const userId = caller.role === "member" ? (caller.user ?? "") : user;
    return listAudit(db, { ...query, userId, threadId: thread });
  });
}
