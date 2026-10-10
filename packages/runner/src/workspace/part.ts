import type { Op } from "@bb/plugin";
import { MACHINE_OPS } from "../contract.js";
import type { PluginRunnerEntry } from "../plugins.js";
import type { WorkspaceApi } from "../workspace-types.js";

export function workspacePart(api: WorkspaceApi): PluginRunnerEntry {
  return (bb) => {
    for (const member of MACHINE_OPS) {
      const run = api[member.method] as (input: unknown) => Promise<unknown>;
      bb.implement(member as Op, (input) => run(input));
    }
  };
}
