import { runner, type PluginRunnerApi } from "@bb/runner";
import { codex } from "./contract.js";
import { createCodexAdapter } from "./runner/codex.js";
import { readCodexUsage } from "./runner/usage.js";

export default function plugin(bb: PluginRunnerApi): void {
  bb.add(runner.provider, createCodexAdapter());
  bb.implement(codex.usage, () => readCodexUsage());
}
