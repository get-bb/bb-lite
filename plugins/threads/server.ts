import { PERSONAL_PROJECT_ID } from "@bb/domain";
import { projects, sections, threads, type PluginServerApi } from "@bb/plugin";
import {
  decodeEvent,
  lastOutput,
  listEvents,
} from "@bb/server-kit/db/event-read";
import { listThreadRows } from "@bb/server-kit/db/thread-read";
import {
  createThreadSection,
  listThreadSections,
} from "@bb/server-kit/db/thread-sections";
import { toThreadListEntries } from "@bb/server-kit/threads/thread-display";
import { createThreadEngine } from "./engine.js";
import { registerThreadReadRoutes } from "./read-routes.js";
import { registerThreadRoutes } from "./routes.js";

const THREADS_VIEW = `CREATE VIEW p_threads_threads AS
  SELECT id, project_id, environment_id, provider_id,
    COALESCE(title, title_fallback) AS title, status, parent_thread_id,
    archived_at, created_at, updated_at
  FROM threads WHERE deleted_at IS NULL`;

export default function threadsPlugin(bb: PluginServerApi): void {
  const { db, realtime: hub } = bb;
  const engine = createThreadEngine(bb);
  bb.http.api((app) => registerThreadRoutes(app, bb, engine));
  bb.http.api((app) => registerThreadReadRoutes(app, bb));
  bb.implement(threads.workspace, ({ threadId }) =>
    engine.workspaceOf(threadId),
  );
  bb.implement(threads.requestInput, (request) => engine.requestInput(request));
  bb.implement(threads.settled, () => engine.settled());
  bb.implement(threads.sweep, () => engine.sweep());
  bb.on(projects.deleted, (deleted) => engine.releaseDeletedProject(deleted));
  bb.storage.tables.migrate([THREADS_VIEW]);
  bb.storage.tables.publish(threads.table, "threads");
  bb.implement(threads.get, ({ threadId }) => engine.get(threadId));
  bb.implement(threads.list, (query = {}) =>
    toThreadListEntries(bb, listThreadRows(db, query)),
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
  bb.onStart(() => {
    engine.start();
    return () => engine.close();
  });
}
