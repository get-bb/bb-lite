import {
  applyAppKeybindingOverrides,
  appSettingsSchema,
  defaultAppTheme,
  defaultFeatureFlags,
  getUiPreferenceDefault,
  isBuiltInThemeId,
  isUiPreferenceKey,
  parseUiPreferenceValue,
  resolveCodeTheme,
  UI_PREFERENCE_KEYS,
  type AppTheme,
  type AppThemeSelection,
  type PluginThemeMeta,
  type UiPreferenceEntries,
  type UiPreferenceKey,
} from "@bb/domain";
import { publicApiRoutes, type ServerAccessStatus } from "@bb/server-contract";
import type { ServerContext } from "../../context.js";
import { writeRevision, type Db } from "../../db/index.js";
import {
  appearanceSetting,
  getAppSettings,
  keybindingOverridesSetting,
  readSetting,
  setAppSettings,
  writeSetting,
} from "../../db/settings.js";
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

const NO_PLUGIN_THEMES: PluginThemeMeta[] = [];
const DIRECT_ACCESS: ServerAccessStatus["providers"][number] = {
  id: "direct",
  displayName: "Manual",
  description: "Use your own domain or network address.",
  pluginId: null,
  availability: null,
};

function builtInTheme(selection: AppThemeSelection): AppTheme {
  const { themeId, faviconColor } = selection;
  const paletteId = isBuiltInThemeId(themeId)
    ? themeId
    : defaultAppTheme.themeId;
  const resolvedCodeTheme = resolveCodeTheme(null, paletteId);
  return {
    themeId: paletteId,
    customCss: null,
    faviconColor,
    resolvedCodeTheme,
  };
}

function requireBuiltInTheme(themeId: string): void {
  if (isBuiltInThemeId(themeId)) return;
  throw new ApiError(404, "theme_not_found", `Unknown theme '${themeId}'.`);
}

function serverPlatform(): "darwin" | "linux" | "unknown" {
  const { platform } = process;
  return platform === "darwin" || platform === "linux" ? platform : "unknown";
}

function requireUiPreferenceKey(key: string): UiPreferenceKey {
  if (isUiPreferenceKey(key)) return key;
  throw new ApiError(
    404,
    "ui_preference_not_found",
    `Unknown UI preference '${key}'. Known preferences: ` +
      `${UI_PREFERENCE_KEYS.join(", ")}.`,
  );
}

function readUiPreferences(db: Db): UiPreferenceEntries {
  const sql = "SELECT key, value_json, revision FROM ui_preferences";
  const rows = db.all<PreferenceRow>(sql);
  const entries = UI_PREFERENCE_KEYS.map((key) => {
    const row = rows.find((stored) => stored.key === key);
    const fallback = getUiPreferenceDefault(key);
    if (row === undefined) return [key, { revision: 0, value: fallback }];
    const stored = parseUiPreferenceValue(key, JSON.parse(row.valueJson));
    const value = stored.success ? stored.value : fallback;
    return [key, { revision: row.revision, value }];
  });
  return Object.fromEntries(entries) as UiPreferenceEntries;
}

function writeUiPreference(
  db: Db,
  key: UiPreferenceKey,
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
  const appearance = () => readSetting(db, appearanceSetting);

  get(routes.config, (c) => {
    const generalSettings = getAppSettings(db);
    const keybindingOverrides = readSetting(db, keybindingOverridesSetting);
    const publicUrl = publicServerUrl(ctx);
    return c.json({
      featureFlags: defaultFeatureFlags,
      pluginThemes: NO_PLUGIN_THEMES,
      serverAccess: {
        providers: [DIRECT_ACCESS],
        defaultProviderId: DIRECT_ACCESS.id,
        effectiveUrl: publicUrl,
        urlSource: publicUrl === null ? null : "setting",
      },
      generalSettings,
      keybindings: applyAppKeybindingOverrides(
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
    const { showUnhandledProviderEvents, ...settings } = payload;
    const updated = appSettingsSchema.parse({
      ...getAppSettings(db),
      ...settings,
      showDiagnosticEvents:
        "showDiagnosticEvents" in settings
          ? settings.showDiagnosticEvents
          : showUnhandledProviderEvents,
    });
    setAppSettings(db, updated);
    hub.system(["config-changed"]);
    return c.json(updated);
  });

  put(routes.keyboardSettings, (c, overrides) => {
    writeSetting(db, keybindingOverridesSetting, overrides);
    hub.system(["config-changed"]);
    return c.json(overrides);
  });

  put(routes.appearance, (c, selection) => {
    requireBuiltInTheme(selection.themeId);
    writeSetting(db, appearanceSetting, selection);
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
    const parsed = parseUiPreferenceValue(key, payload.value);
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
    const value = getUiPreferenceDefault(key);
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
