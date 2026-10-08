import { runner, type PluginRunnerApi } from "@bb/runner";
import { createCodexAdapter } from "./runner/codex.js";

export default function plugin(bb: PluginRunnerApi): void {
  bb.add(runner.provider, createCodexAdapter());
}
