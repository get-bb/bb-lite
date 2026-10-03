import * as react from "react";
import * as reactDom from "react-dom";
import * as reactDomClient from "react-dom/client";
import * as jsxRuntime from "react/jsx-runtime";
import * as baseContextMenu from "@base-ui/react/context-menu";
import * as baseDialog from "@base-ui/react/dialog";
import * as baseMenu from "@base-ui/react/menu";
import * as basePopover from "@base-ui/react/popover";
import * as baseSelect from "@base-ui/react/select";
import * as baseTooltip from "@base-ui/react/tooltip";
import * as sonner from "sonner";
import * as clsx from "clsx";
import * as tailwindMerge from "tailwind-merge";
import * as classVarianceAuthority from "class-variance-authority";
import * as pluginApp from "@bb/plugin/app";
import { pluginListQueryOptions } from "@/hooks/queries/plugin-settings-queries";
import { appQueryClient } from "@/lib/app-query-client";
import { setPluginBranding } from "@/lib/plugin-logos";
import { BUILTIN_PLUGINS, type BuiltinPlugin } from "./builtin";
import { pluginAppHost } from "./host";
import {
  isPluginAppDefinition,
  markPluginsSettled,
  registerPluginApp,
  unregisterPluginApp,
} from "./registry";

const RUNTIME_MODULES: Record<
  (typeof pluginApp.PLUGIN_SHARED_MODULES)[number],
  unknown
> = {
  react,
  "react-dom": reactDom,
  "react-dom/client": reactDomClient,
  "react/jsx-runtime": jsxRuntime,
  "@bb/plugin/app": pluginApp,
  "@base-ui/react/context-menu": baseContextMenu,
  "@base-ui/react/dialog": baseDialog,
  "@base-ui/react/menu": baseMenu,
  "@base-ui/react/popover": basePopover,
  "@base-ui/react/select": baseSelect,
  "@base-ui/react/tooltip": baseTooltip,
  sonner,
  clsx,
  "tailwind-merge": tailwindMerge,
  "class-variance-authority": classVarianceAuthority,
};

const CSS_ATTRIBUTE = "data-bb-plugin-css";
const disabledBuiltinIds = new Set<string>();
const externalHashes = new Map<string, string>();
let boot: Promise<void> | null = null;
let syncQueue: Promise<void> = Promise.resolve();

async function loadBuiltin(plugin: BuiltinPlugin): Promise<void> {
  try {
    const module = await plugin.load();
    if (!disabledBuiltinIds.has(plugin.id)) {
      registerPluginApp(plugin.id, module.default);
    }
  } catch (error) {
    console.warn(`[plugin:${plugin.id}] app failed to load`, error);
  }
}

function applyCss(pluginId: string, cssUrl: string | null): void {
  const stale = document.head.querySelectorAll(
    `link[${CSS_ATTRIBUTE}="${CSS.escape(pluginId)}"]`,
  );
  if (cssUrl !== null) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = cssUrl;
    link.setAttribute(CSS_ATTRIBUTE, pluginId);
    document.head.append(link);
  }
  for (const link of stale) link.remove();
}

function dropExternal(pluginId: string): void {
  unregisterPluginApp(pluginId);
  applyCss(pluginId, null);
  externalHashes.delete(pluginId);
}

async function syncPlugins(refetch: boolean): Promise<void> {
  const query = {
    ...pluginListQueryOptions({ enabled: true }),
    ...(refetch ? { staleTime: 0 } : {}),
  };
  let plugins;
  try {
    plugins = await appQueryClient
      .fetchQuery(query)
      .catch(() => appQueryClient.fetchQuery(query));
  } catch (error) {
    console.warn("plugin list failed to load", error);
    return;
  }
  setPluginBranding(plugins);
  const pluginsById = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const builtinLoads = BUILTIN_PLUGINS.map((plugin) => {
    if (pluginsById.get(plugin.id)?.enabled === false) {
      disabledBuiltinIds.add(plugin.id);
      unregisterPluginApp(plugin.id);
      return null;
    }
    return disabledBuiltinIds.delete(plugin.id) ? loadBuiltin(plugin) : null;
  });
  for (const pluginId of [...externalHashes.keys()]) {
    const plugin = pluginsById.get(pluginId);
    if (!plugin?.enabled || plugin.app?.kind !== "external") {
      dropExternal(pluginId);
    }
  }
  const externalLoads = plugins.map(async (plugin) => {
    const app = plugin.app;
    if (!plugin.enabled || app?.kind !== "external") return;
    if (externalHashes.get(plugin.id) === app.hash) return;
    try {
      const module: { default?: unknown } = await import(app.jsUrl);
      if (!isPluginAppDefinition(module.default)) {
        throw new Error("the default export is not definePluginApp(...)");
      }
      applyCss(plugin.id, app.cssUrl);
      const failure = registerPluginApp(plugin.id, module.default);
      if (failure !== null) throw failure;
      externalHashes.set(plugin.id, app.hash);
    } catch (error) {
      console.warn(`[plugin:${plugin.id}] app failed to load`, error);
      dropExternal(plugin.id);
    }
  });
  await Promise.all([...builtinLoads, ...externalLoads]);
}

export function bootPlugins(): Promise<void> {
  boot ??= (async () => {
    pluginApp.installPluginAppHost(pluginAppHost);
    Object.assign(globalThis, {
      [pluginApp.PLUGIN_RUNTIME_GLOBAL]: RUNTIME_MODULES,
    });
    syncQueue = syncPlugins(false);
    await Promise.all([...BUILTIN_PLUGINS.map(loadBuiltin), syncQueue]);
    markPluginsSettled();
  })();
  return boot;
}

export function reloadPlugins(): void {
  if (boot === null) return;
  syncQueue = syncQueue.then(() => syncPlugins(true));
}
