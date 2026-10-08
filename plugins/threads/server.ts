import { PERSONAL_PROJECT_ID } from "@bb/domain";
import { sections, threads, type PluginServerApi } from "@bb/plugin";
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
import { coreOf } from "@bb/server-kit/host";
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
  const { ctx, routes } = coreOf(bb);
  const { db, hub } = ctx;
  const engine = createThreadEngine(ctx, bb);
  ctx.threads = engine;
  routes(registerThreadRoutes, registerThreadReadRoutes);
  bb.storage.tables.migrate([THREADS_VIEW]);
  bb.storage.tables.publish(threads.table, "threads");
  bb.implement(threads.get, ({ threadId }) => engine.get(threadId));
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
  bb.onStart(() => {
    engine.start();
    return () => engine.close();
  });
}
