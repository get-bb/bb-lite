import {
  environments as contract,
  threads,
  type PluginServerApi,
} from "@bb/plugin";
import { environmentRuntime } from "./contract.js";
import { createEnvironments } from "./manager.js";
import { implementEnvironments } from "./ops.js";

export default function environments(bb: PluginServerApi): void {
  const manager = createEnvironments(bb);
  implementEnvironments(bb, (id) => manager.remove(id));
  bb.implement(environmentRuntime.ensure, (job) =>
    manager.ensureForThread(job),
  );
  bb.implement(contract.instructions, ({ environmentId }) =>
    manager.workspaceInstructions(environmentId),
  );
  bb.implement(contract.sweep, () => manager.sweep());
  const detached = ({ thread }: { thread: { id: string } }) =>
    manager.onThreadDetached(thread.id);
  bb.on(threads.archived, detached);
  bb.on(threads.unarchived, detached);
  bb.on(threads.deleted, detached);
  bb.onStart(() => manager.start());
}
