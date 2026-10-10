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
import { pluginListQueryOptions } from "@bb/app-kit/hooks/queries/plugin-settings-queries";
import { appQueryClient } from "@bb/app-kit/lib/app-query-client";
import { setPluginBranding } from "@bb/app-kit/lib/plugin-logos";
import { onPluginsChanged } from "@bb/app-kit/lib/plugin-reload";
import { BUILTIN_PLUGINS, CORE_PLUGINS, type BuiltinPlugin } from "./builtin";
import { wsManager } from "@bb/app-kit/lib/ws";
import { OP_QUERY_KEY, pluginAppHost } from "./host";
import {
  appKernel,
  markPluginsSettled,
  registerPluginApp,
  unregisterPluginApp,
} from "@bb/app-kit/plugins/registry";

const BOOT_MODULES: Record<
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

const RUNTIME_MODULES: Record<string, unknown> = { ...BOOT_MODULES };

type Loader = () => Promise<unknown>;
type PackageExports = Record<string, { source?: string } | undefined>;

const SHARED_UI_ROOT = "../../../../packages/shared-ui";
const sharedUiFiles: Record<string, Loader> = import.meta.glob(
  "../../../../packages/shared-ui/src/**/*.{ts,tsx}",
);
const sharedUiManifests: Record<string, PackageExports> = import.meta.glob(
  "../../../../packages/shared-ui/package.json",
  { eager: true, import: "exports" },
);
const sharedUiExports = Object.values(sharedUiManifests)[0] ?? {};

const HOST_LOADERS: Record<
  (typeof pluginApp.PLUGIN_HOST_MODULES)[number],
  Loader
> = {
  "@bb/client-core": () => import("@bb/client-core"),
  "@bb/core-ui": () => import("@bb/core-ui"),
  "@tanstack/react-query": () => import("@tanstack/react-query"),
  jotai: () => import("jotai"),
  "jotai/utils": () => import("jotai/utils"),
  "react-router-dom": () => import("react-router-dom"),
};

const ZOD_LOADERS: Record<
  (typeof pluginApp.PLUGIN_ZOD_MODULES)[number],
  Loader
> = {
  zod: () => import("zod"),
  "zod/mini": () => import("zod/mini"),
  "zod/v4": () => import("zod/v4"),
  "zod/v4/core": () => import("zod/v4/core"),
  "zod/v4/mini": () => import("zod/v4/mini"),
};

const APP_KIT_ROOT = "../../../../packages/app-kit";
const APP_KIT_PREFIX = "@bb/app-kit/";
const APP_KIT_SUFFIXES = [".ts", ".tsx", "/index.ts", "/index.tsx"];
const appKitFiles: Record<string, Loader> = import.meta.glob([
  "../../../../packages/app-kit/**/*.{ts,tsx}",
  "!**/node_modules/**",
  "!../../../../packages/app-kit/test/**",
]);

function appKitLoader(specifier: string): Loader | undefined {
  const path = `${APP_KIT_ROOT}/${specifier.slice(APP_KIT_PREFIX.length)}`;
  const file = APP_KIT_SUFFIXES.map((suffix) => path + suffix).find(
    (candidate) => candidate in appKitFiles,
  );
  return file === undefined ? undefined : appKitFiles[file];
}

function hostLoader(specifier: string): Loader | undefined {
  const named: Record<string, Loader | undefined> = {
    ...HOST_LOADERS,
    ...ZOD_LOADERS,
  };
  const prefix = "@bb/shared-ui/";
  if (specifier.startsWith(APP_KIT_PREFIX)) return appKitLoader(specifier);
  if (!specifier.startsWith(prefix)) return named[specifier];
  const entry = sharedUiExports[`./${specifier.slice(prefix.length)}`];
  const source = entry?.source;
  if (source === undefined) return undefined;
  return sharedUiFiles[`${SHARED_UI_ROOT}/${source.replace(/^\.\//u, "")}`];
}

async function shareWithPlugins(specifiers: readonly string[]): Promise<void> {
  for (const specifier of specifiers) {
    if (specifier in RUNTIME_MODULES) continue;
    const load = hostLoader(specifier);
    if (load === undefined) {
      throw new Error(`this bb does not share "${specifier}" with plugins`);
    }
    RUNTIME_MODULES[specifier] = await load();
  }
}

const CSS_ATTRIBUTE = "data-bb-plugin-css";
const KERNEL_SIGNAL = "kernel";
const disabledBuiltinIds = new Set<string>();
const externalHashes = new Map<string, string>();
let boot: Promise<void> | null = null;
let syncQueue: Promise<void> = Promise.resolve();

export function registerCorePlugins(): void {
  for (const { id, app } of CORE_PLUGINS) {
    const failure = registerPluginApp(id, app);
    if (failure !== null) throw failure;
  }
}

async function loadBuiltin(plugin: BuiltinPlugin): Promise<void> {
  try {
    const module = await plugin.load();
    if (!disabledBuiltinIds.has(plugin.id)) {
      if (externalHashes.has(plugin.id)) dropExternal(plugin.id);
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

const UTILITIES_ATTRIBUTE = "data-bb-plugin-utilities";

function applyUtilities(url: string | null): void {
  const selector = `link[${UTILITIES_ATTRIBUTE}]`;
  const current = document.head.querySelector<HTMLLinkElement>(selector);
  if (current?.getAttribute("href") === url) return;
  if (url === null) {
    current?.remove();
    return;
  }
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = url;
  link.setAttribute(UTILITIES_ATTRIBUTE, "");
  link.addEventListener("load", () => current?.remove(), { once: true });
  link.addEventListener("error", () => link.remove(), { once: true });
  document.head.append(link);
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
  const replacedIds: string[] = [];
  const builtinLoads = [...CORE_PLUGINS, ...BUILTIN_PLUGINS].map((plugin) => {
    const listed = pluginsById.get(plugin.id);
    if (listed?.app?.kind === "external" && listed.enabled) {
      replacedIds.push(plugin.id);
      return null;
    }
    if (listed?.enabled === false) {
      dropBuiltin(plugin.id);
      return null;
    }
    return disabledBuiltinIds.delete(plugin.id) ? loadBuiltin(plugin) : null;
  });
  const externalLoads = plugins.map(async (plugin) => {
    const app = plugin.app;
    if (!plugin.enabled || app?.kind !== "external") return null;
    if (externalHashes.get(plugin.id) === app.hash) return null;
    try {
      await shareWithPlugins(app.shared ?? []);
      const module: { default?: unknown } = await import(app.jsUrl);
      const entry = module.default;
      if (typeof entry !== "function") {
        throw new Error("the default export is not a function");
      }
      const setup = entry as pluginApp.PluginAppEntry;
      return { plugin, app, setup };
    } catch (error) {
      console.warn(`[plugin:${plugin.id}] app failed to load`, error);
      dropExternal(plugin.id);
      return null;
    }
  });
  const loaded = await Promise.all(externalLoads);
  await Promise.all(builtinLoads);
  for (const pluginId of [...externalHashes.keys()]) {
    const plugin = pluginsById.get(pluginId);
    if (!plugin?.enabled || plugin.app?.kind !== "external") {
      dropExternal(pluginId);
    }
  }
  for (const pluginId of replacedIds) dropBuiltin(pluginId);
  for (const load of loaded) {
    if (load === null) continue;
    const { plugin, app, setup } = load;
    applyCss(plugin.id, app.cssUrl);
    const failure = registerPluginApp(plugin.id, setup, "installed");
    if (failure === null) {
      externalHashes.set(plugin.id, app.hash);
      continue;
    }
    console.warn(`[plugin:${plugin.id}] app failed to load`, failure);
    dropExternal(plugin.id);
  }
  const styled = plugins.flatMap(({ enabled, app }) =>
    enabled && app?.kind === "external" ? [app.utilitiesUrl ?? null] : [],
  );
  applyUtilities(styled.find((url) => url !== null) ?? null);
}

function dropBuiltin(pluginId: string): void {
  if (disabledBuiltinIds.has(pluginId)) return;
  disabledBuiltinIds.add(pluginId);
  unregisterPluginApp(pluginId);
}

export function bootPlugins(): Promise<void> {
  boot ??= (async () => {
    pluginApp.installPluginAppHost(pluginAppHost);
    onPluginsChanged(reloadPlugins);
    wsManager.onPluginSignal(({ pluginId, channel, payload }) => {
      if (pluginId !== KERNEL_SIGNAL) return;
      if (channel === "emitted") {
        const event = payload as { name: string; payload: unknown };
        appKernel().deliver(event.name, event.payload, { hostId: null });
        return;
      }
      if (channel !== "changed") return;
      const { name } = payload as { name?: unknown };
      const queryKey = [OP_QUERY_KEY, name];
      void appQueryClient.invalidateQueries({ queryKey });
    });
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
