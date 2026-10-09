import { runner, type PluginRunnerApi } from "@bb/runner";
import { createPiAdapter } from "./runner/pi.js";

export default function plugin(bb: PluginRunnerApi): void {
  bb.add(runner.provider, createPiAdapter());
}
