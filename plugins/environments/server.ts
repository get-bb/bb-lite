import {
  environments as contract,
  threads,
  type PluginServerApi,
} from "@bb/plugin";
import {
  getEnvironment,
  listEnvironments,
} from "@bb/server-kit/db/environments";
import { environmentRuntime } from "./contract.js";
import { createEnvironments } from "./manager.js";
import { registerEnvironmentRoutes } from "./routes.js";

export default function environments(bb: PluginServerApi): void {
  const manager = createEnvironments(bb);
  bb.http.api((app) => registerEnvironmentRoutes(app, bb));
  bb.implement(contract.get, ({ environmentId }) => {
    return getEnvironment(bb.db, environmentId) ?? null;
  });
  bb.implement(contract.list, (filter) => listEnvironments(bb.db, filter));
  bb.implement(environmentRuntime.ensure, (job) =>
    manager.ensureForThread(job),
  );
  bb.implement(contract.instructions, ({ environmentId }) =>
    manager.workspaceInstructions(environmentId),
  );
  bb.implement(contract.remove, ({ environmentId }) =>
    manager.remove(environmentId),
  );
  bb.implement(contract.sweep, () => manager.sweep());
  const detached = ({ thread }: { thread: { id: string } }) =>
    manager.onThreadDetached(thread.id);
  bb.on(threads.archived, detached);
  bb.on(threads.unarchived, detached);
  bb.on(threads.deleted, detached);
  bb.onStart(() => manager.start());
}
