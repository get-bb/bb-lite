import { runner, type PluginRunnerApi } from "@bb/runner";
import { claudeCode } from "./contract.js";
import { createClaudeAdapter } from "./runner/claude.js";
import { readClaudeUsage } from "./runner/usage.js";

export default function plugin(bb: PluginRunnerApi): void {
  bb.add(runner.provider, createClaudeAdapter());
  bb.implement(claudeCode.usage, () => readClaudeUsage());
}
