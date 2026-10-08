export const PLUGIN_RUNTIME_GLOBAL = "__bbPluginRuntime";

export const PLUGIN_SHARED_MODULES = [
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "@bb/plugin/app",
  "sonner",
  "clsx",
  "tailwind-merge",
  "class-variance-authority",
  "@base-ui/react/context-menu",
  "@base-ui/react/dialog",
  "@base-ui/react/menu",
  "@base-ui/react/popover",
  "@base-ui/react/select",
  "@base-ui/react/tooltip",
] as const;

export const PLUGIN_HOST_MODULES = [
  "@bb/client-core",
  "@bb/core-ui",
  "@tanstack/react-query",
  "jotai",
  "jotai/utils",
  "react-router-dom",
] as const;

export const PLUGIN_HOST_MODULE_PREFIXES = [
  "@bb/shared-ui/",
  "@bb/app-kit/",
] as const;

export function isHostModule(specifier: string): boolean {
  const names: readonly string[] = [
    ...PLUGIN_SHARED_MODULES,
    ...PLUGIN_HOST_MODULES,
  ];
  return (
    names.includes(specifier) ||
    PLUGIN_HOST_MODULE_PREFIXES.some((prefix) => specifier.startsWith(prefix))
  );
}
