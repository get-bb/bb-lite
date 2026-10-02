import { defaultFeatureFlags, type PluginThemeMeta } from "@bb/domain";
import type { ServerAccessStatus } from "@bb/server-contract";

const NO_PLUGIN_THEMES: PluginThemeMeta[] = [];

export const DIRECT_SERVER_ACCESS_PROVIDER: ServerAccessStatus["providers"][number] =
  {
    id: "direct",
    displayName: "Manual",
    description: "Use your own domain or network address.",
    pluginId: null,
    availability: null,
  };

export const CUT_FEATURE_SYSTEM_CONFIG = {
  featureFlags: defaultFeatureFlags,
  pluginThemes: NO_PLUGIN_THEMES,
};
