import { machines, projects, threads, type PluginServerApi } from "@bb/plugin";
import { createThreadEngine } from "./engine.js";
import { implementThreadViews } from "./ops.js";
import { implementThreadReads } from "./reads.js";

const THREADS_VIEW = `CREATE VIEW p_threads_threads AS
  SELECT id, project_id, environment_id, provider_id,
    COALESCE(title, title_fallback) AS title, status, parent_thread_id,
    archived_at, created_at, updated_at
  FROM threads WHERE deleted_at IS NULL`;

export default function threadsPlugin(bb: PluginServerApi): void {
  const engine = createThreadEngine(bb);
  implementThreadReads(bb);
  implementThreadViews(bb);
  bb.implement(threads.workspace, ({ threadId }) =>
    engine.workspaceOf(threadId),
  );
  bb.implement(threads.waitSettled, () => engine.settled());
  bb.implement(threads.sweep, () => engine.sweep());
  bb.on(projects.deleted, (deleted) => engine.releaseDeletedProject(deleted));
  bb.on(machines.deleted, (deleted) =>
    engine.failQueuedOnRemovedMachine(deleted),
  );
  bb.storage.tables.migrate([THREADS_VIEW]);
  bb.storage.tables.publish(threads.table, "threads");
  bb.onStart(() => {
    engine.start();
    return () => engine.close();
  });
}
