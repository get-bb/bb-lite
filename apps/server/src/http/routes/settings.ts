import * as domain from "@bb/domain";
import { publicApiRoutes, type ServerAccessStatus } from "@bb/server-contract";
import type { ServerContext } from "../../context.js";
import { writeRevision, type Db } from "../../db/index.js";
import * as store from "../../db/settings.js";
import {
  machineEnvironmentView,
  projectMachineEnvironmentView,
  replaceMachineEnvironment,
} from "../../machine-environment.js";
import { requireProject } from "../../db/projects.js";
import { publicServerUrl } from "../../runners/hosts.js";
import { DEFAULT_APP_KEYBINDINGS } from "../../settings/keybindings.js";
import { typedApi, type ApiApp } from "../api.js";
import { ApiError, invalidRequest } from "../errors.js";

interface PreferenceRow {
  key: string;
  valueJson: string;
  revision: number;
}

const NO_PLUGIN_THEMES: domain.PluginThemeMeta[] = [];
const DIRECT_ACCESS: ServerAccessStatus["providers"][number] = {
  id: "direct",
  displayName: "Manual",
  description: "Use your own domain or network address.",
  pluginId: null,
  availability: null,
};

function builtInTheme(selection: domain.AppThemeSelection): domain.AppTheme {
  const { themeId, faviconColor } = selection;
  const paletteId = domain.isBuiltInThemeId(themeId)
    ? themeId
    : domain.defaultAppTheme.themeId;
  const resolvedCodeTheme = domain.resolveCodeTheme(null, paletteId);
  return {
    themeId: paletteId,
    customCss: null,
    faviconColor,
    resolvedCodeTheme,
  };
}

function requireBuiltInTheme(themeId: string): void {
  if (domain.isBuiltInThemeId(themeId)) return;
  throw new ApiError(404, "theme_not_found", `Unknown theme '${themeId}'.`);
}

function serverPlatform(): "darwin" | "linux" | "unknown" {
  const { platform } = process;
  return platform === "darwin" || platform === "linux" ? platform : "unknown";
}

function requireUiPreferenceKey(key: string): domain.UiPreferenceKey {
  if (domain.isUiPreferenceKey(key)) return key;
  throw new ApiError(
    404,
    "ui_preference_not_found",
    `Unknown UI preference '${key}'. Known preferences: ` +
      `${domain.UI_PREFERENCE_KEYS.join(", ")}.`,
  );
}

function readUiPreferences(db: Db): domain.UiPreferenceEntries {
  const sql = "SELECT key, value_json, revision FROM ui_preferences";
  const rows = db.all<PreferenceRow>(sql);
  const entries = domain.UI_PREFERENCE_KEYS.map((key) => {
    const row = rows.find((stored) => stored.key === key);
    const fallback = domain.getUiPreferenceDefault(key);
    if (row === undefined) return [key, { revision: 0, value: fallback }];
    const stored = domain.parseUiPreferenceValue(
      key,
      JSON.parse(row.valueJson),
    );
    const value = stored.success ? stored.value : fallback;
    return [key, { revision: row.revision, value }];
  });
  return Object.fromEntries(entries) as domain.UiPreferenceEntries;
}

function writeUiPreference(
  db: Db,
  key: domain.UiPreferenceKey,
  value: unknown,
  expectedRevision: number | null,
): number {
  const row = { key, valueJson: JSON.stringify(value) };
  const write = writeRevision(
    db,
    "ui_preferences",
    "key",
    row,
    expectedRevision,
  );
  if (write.outcome === "updated") return write.revision;
  const message = "UI preference changed on another client";
  const details = { currentRevision: write.revision };
  throw new ApiError(409, "ui_preference_conflict", message, { details });
}

export function registerSettingsRoutes(app: ApiApp, ctx: ServerContext): void {
  const { del, get, put } = typedApi(app);
  const { system: routes, projects } = publicApiRoutes;
  const { db, hub } = ctx;
  const appearance = () => store.readSetting(db, store.appearanceSetting);

  get(routes.config, (c) => {
    const generalSettings = store.getAppSettings(db);
    const keybindingOverrides = store.readSetting(
      db,
      store.keybindingOverridesSetting,
    );
    const publicUrl = publicServerUrl(ctx);
    return c.json({
      featureFlags: domain.defaultFeatureFlags,
      pluginThemes: NO_PLUGIN_THEMES,
      serverAccess: {
        providers: [DIRECT_ACCESS],
        defaultProviderId: DIRECT_ACCESS.id,
        effectiveUrl: publicUrl,
        urlSource: publicUrl === null ? null : "setting",
      },
      generalSettings,
      keybindings: domain.applyAppKeybindingOverrides(
        DEFAULT_APP_KEYBINDINGS,
        keybindingOverrides,
      ),
      defaultKeybindings: DEFAULT_APP_KEYBINDINGS,
      keybindingOverrides,
      appearance: builtInTheme(appearance()),
      customThemes: [],
      serverUrl: publicUrl ?? new URL(c.req.url).origin,
      primaryHostId: ctx.config.hostId,
      primaryHostPlatform: serverPlatform(),
      dataDir: ctx.config.dataDir,
    });
  });

  put(routes.generalSettings, (c, payload) => {
    const { showUnhandledProviderEvents: _legacy, ...settings } = payload;
    const stored = store.getAppSettings(db);
    const updated = domain.appSettingsSchema.parse({ ...stored, ...settings });
    store.setAppSettings(db, updated);
    hub.system(["config-changed"]);
    return c.json(updated);
  });

  put(routes.keyboardSettings, (c, overrides) => {
    store.writeSetting(db, store.keybindingOverridesSetting, overrides);
    hub.system(["config-changed"]);
    return c.json(overrides);
  });

  put(routes.appearance, (c, selection) => {
    requireBuiltInTheme(selection.themeId);
    store.writeSetting(db, store.appearanceSetting, selection);
    hub.system(["config-changed"]);
    return c.json(builtInTheme(selection));
  });

  get(routes.resolveTheme, (c) => {
    const themeId = c.req.param("id");
    requireBuiltInTheme(themeId);
    return c.json(builtInTheme({ ...appearance(), themeId }));
  });

  get(routes.uiPreferences, (c) =>
    c.json({ preferences: readUiPreferences(db) }),
  );

  put(routes.updateUiPreference, (c, payload) => {
    const key = requireUiPreferenceKey(c.req.param("key"));
    const parsed = domain.parseUiPreferenceValue(key, payload.value);
    if (!parsed.success) {
      throw invalidRequest(
        `Invalid value for UI preference '${key}': ${parsed.message}`,
      );
    }
    const { value } = parsed;
    const revision = writeUiPreference(
      db,
      key,
      value,
      payload.expectedRevision,
    );
    hub.system(["ui-preferences-changed"]);
    return c.json({ key, revision, value });
  });

  del(routes.resetUiPreference, (c) => {
    const key = requireUiPreferenceKey(c.req.param("key"));
    const value = domain.getUiPreferenceDefault(key);
    const revision = writeUiPreference(db, key, value, null);
    hub.system(["ui-preferences-changed"]);
    return c.json({ key, revision, value });
  });

  get(routes.machineEnvironment, (c) => c.json(machineEnvironmentView(db)));

  put(routes.replaceMachineEnvironment, async (c, payload) => {
    await replaceMachineEnvironment(ctx, null, payload);
    hub.system(["config-changed"]);
    return c.json(machineEnvironmentView(db));
  });

  get(projects.machineEnvironment, (c) => {
    const { id } = requireProject(db, c.req.param("id"));
    return c.json(projectMachineEnvironmentView(db, id));
  });

  put(projects.replaceMachineEnvironment, async (c, payload) => {
    const { id } = requireProject(db, c.req.param("id"));
    await replaceMachineEnvironment(ctx, id, payload);
    hub.system(["config-changed"]);
    return c.json(projectMachineEnvironmentView(db, id));
  });
}
