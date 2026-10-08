import type { PluginAppDefinition } from "@bb/plugin/app";
import { registerPluginApp } from "../registry";
import composer from "./composer";
import settings from "./settings";
import shell from "./shell";
import sidePanel from "./side-panel";
import threadView from "./thread-view";

const CORE_PLUGINS: readonly [id: string, app: PluginAppDefinition][] = [
  ["shell", shell],
  ["thread-view", threadView],
  ["composer", composer],
  ["side-panel", sidePanel],
  ["settings", settings],
];

export function registerCorePlugins(): void {
  for (const [id, app] of CORE_PLUGINS) {
    const failure = registerPluginApp(id, app);
    if (failure !== null) throw failure;
  }
}
