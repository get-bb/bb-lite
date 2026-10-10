import type { KernelInspection, PluginBase } from "@bb/plugin";
import { pluginDev, type MachineParts } from "./contract.js";

export function machineParts(inspection: KernelInspection): MachineParts {
  return inspection.plugins.map(({ id, tier }) => ({
    id,
    tier,
    implements: inspection.ops
      .filter(({ owner }) => owner === id)
      .map(({ name }) => name)
      .sort(),
  }));
}

export default function pluginDevRunner(
  bb: PluginBase & { inspect(): KernelInspection },
): void {
  bb.implement(pluginDev.machineParts, () => machineParts(bb.inspect()));
}
