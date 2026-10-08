import { runner, type PluginRunnerApi } from "@bb/runner";
import { probe } from "./contract.js";

export default function plugin(bb: PluginRunnerApi): void {
  bb.implement(probe.sum, ({ a, b }) => ({ dataDir: bb.dataDir, sum: a + b }));
  bb.add(runner.provider, {
    id: "probe",
    approvalEnforcedBy: "runner",
    status: async () => ({
      providerId: "probe",
      installed: true,
      executablePath: null,
      version: "1",
      auth: "ready",
      message: null,
    }),
    listModels: async () => ({ models: [], selectedOnlyModels: [] }),
    open: async () => {
      throw new Error("The probe provider cannot run turns");
    },
  });
}
