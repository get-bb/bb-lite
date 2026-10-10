import { availableParallelism } from "node:os";
import type { PluginRunnerApi } from "@bb/runner";
import { concurrencyLimit } from "./contract.js";

export default function concurrencyLimitRunner(bb: PluginRunnerApi): void {
  bb.implement(concurrencyLimit.capacity, () => ({
    availableParallelism: availableParallelism(),
  }));
}
