import { runner, type PluginRunnerApi } from "@bb/runner";
import { createClaudeAdapter } from "./runner/claude.js";

export default function plugin(bb: PluginRunnerApi): void {
  bb.add(runner.provider, createClaudeAdapter());
}
