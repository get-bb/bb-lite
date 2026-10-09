import type { PluginAppEntry } from "@bb/plugin/app";
import { appLoaders } from "./builtins.app";
import { CORE, LOADED_FIRST } from "./profiles";
import composer from "../../plugins/composer/app";
import settings from "../../plugins/settings/app";
import shell from "../../plugins/shell/app";
import sidePanel from "../../plugins/side-panel/app";
import threadView from "../../plugins/thread-view/app";

export interface BuiltinAppPlugin {
  id: string;
  load: () => Promise<{ default: PluginAppEntry }>;
}

export interface CoreAppPlugin extends BuiltinAppPlugin {
  app: PluginAppEntry;
}

function core(id: string, app: PluginAppEntry): CoreAppPlugin {
  return { id, app, load: async () => ({ default: app }) };
}

export const coreAppPlugins: readonly CoreAppPlugin[] = [
  core("shell", shell),
  core("thread-view", threadView),
  core("composer", composer),
  core("side-panel", sidePanel),
  core("settings", settings),
];

const ids = Object.keys(appLoaders).filter((id) => !CORE.includes(id));
const ordered = [
  ...LOADED_FIRST.filter((id) => ids.includes(id)),
  ...ids.filter((id) => !LOADED_FIRST.includes(id)).sort(),
];

export const appPlugins: readonly BuiltinAppPlugin[] = ordered.flatMap((id) => {
  const load = appLoaders[id];
  return load === undefined ? [] : [{ id, load }];
});
