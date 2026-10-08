import { runner, type PluginRunnerApi } from "@bb/runner";
import { echoEnabled } from "./enabled.js";
import { createEchoAdapter } from "./runner/echo.js";

export default function plugin(bb: PluginRunnerApi): void {
  if (echoEnabled()) bb.add(runner.provider, createEchoAdapter());
}
