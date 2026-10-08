import type { PluginServerApi } from "@bb/plugin";
import * as domain from "@bb/domain";
import { appearance as appearanceSlots } from "@bb/plugin";
import { publicApiRoutes, type ServerAccessStatus } from "@bb/server-contract";
import { viewerId } from "@bb/server-kit/auth/actor";
import { writeRevision, type Db } from "@bb/server-kit/db/index";
import * as store from "@bb/server-kit/db/settings";
import {
  machineEnvironmentView,
  projectMachineEnvironmentView,
  replaceMachineEnvironment,
} from "@bb/server-kit/machine-environment";
import { requireProject } from "@bb/server-kit/db/projects";
import { defaultHostId } from "@bb/server-kit/runners/access";
import { publicServerUrl } from "@bb/server-kit/runners/hosts";
import { DEFAULT_APP_KEYBINDINGS } from "./keybindings.js";
import { typedApi, type ApiApp } from "@bb/server-kit/http/api";
import { ApiError, invalidRequest } from "@bb/server-kit/http/errors";
import { requireOwner } from "@bb/server-kit/http/trust";

interface PreferenceRow {
  key: string;
  valueJson: string;
  revision: number;
}

const DIRECT_ACCESS: ServerAccessStatus["providers"][number] = {
  id: "direct",
  displayName: "Manual",
  description: "Use your own domain or network address.",
  pluginId: null,
  availability: null,
};

function serverPlatform() {
  const { platform } = process;
  return platform === "darwin" || platform === "linux" ? platform : "unknown";
}

function requireUiPreferenceKey(key: string) {
  if (domain.isUiPreferenceKey(key)) return key;
  throw new ApiError(
    404,
    "ui_preference_not_found",
    `Unknown UI preference '${key}'. Known preferences: ` +
      `${domain.UI_PREFERENCE_KEYS.join(", ")}.`,
  );
}

function readUiPreferences(db: Db) {
  const sql = `SELECT key, value_json, revision FROM ui_preferences
    WHERE user_id = ?`;
  const rows = db.all<PreferenceRow>(sql, viewerId());
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
) {
  const owner = { userId: viewerId(), key };
  const values = { valueJson: JSON.stringify(value) };
  const expected = expectedRevision;
  const write = writeRevision(db, "ui_preferences", owner, values, expected);
  if (write.outcome === "updated") return write.revision;
  const message = "UI preference changed on another client";
  const details = { currentRevision: write.revision };
  throw new ApiError(409, "ui_preference_conflict", message, { details });
}

export function registerSettingsRoutes(app: ApiApp, bb: PluginServerApi): void {
  const { del, get, put } = typedApi(app);
  const { system: routes, projects } = publicApiRoutes;
  const { db, realtime: hub } = bb;
  const personal = <T>(setting: store.Setting<T>) =>
    store.userSetting(setting, viewerId());
  const themes = () =>
    bb.entries(appearanceSlots.theme).map(({ item }) => item);
  const isKnownTheme = (themeId: string) =>
    domain.isBuiltInThemeId(themeId) ||
    themes().some(({ id }) => id === themeId);
  const knownTheme = (selection: domain.AppTheme): domain.AppTheme => {
    const { themeId, faviconColor } = selection;
    const fallback = domain.defaultAppTheme.themeId;
    return {
      themeId: isKnownTheme(themeId) ? themeId : fallback,
      faviconColor,
    };
  };
  const appearance = () =>
    store.readSetting(db, personal(store.appearanceSetting));

  get(routes.config, (c) => {
    const generalSettings = store.getAppSettings(db);
    const keybindingOverrides = store.readSetting(
      db,
      personal(store.keybindingOverridesSetting),
    );
    const publicUrl = publicServerUrl(bb);
    return c.json({
      featureFlags: domain.defaultFeatureFlags,
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
      appearance: knownTheme(appearance()),
      themes: themes(),
      serverUrl: publicUrl ?? new URL(c.req.url).origin,
      primaryHostId: defaultHostId(bb),
      primaryHostPlatform: serverPlatform(),
      dataDir: bb.config.dataDir,
    });
  });

  put(routes.generalSettings, (c, payload) => {
    requireOwner(c, "Only an owner can change this bb's general settings");
    const { showUnhandledProviderEvents: _legacy, ...settings } = payload;
    const stored = store.getAppSettings(db);
    const updated = domain.appSettingsSchema.parse({ ...stored, ...settings });
    store.setAppSettings(db, updated);
    hub.system(["config-changed"]);
    return c.json(updated);
  });

  put(routes.keyboardSettings, (c, overrides) => {
    const setting = personal(store.keybindingOverridesSetting);
    store.writeSetting(db, setting, overrides);
    hub.system(["config-changed"]);
    return c.json(overrides);
  });

  put(routes.appearance, (c, selection) => {
    if (!isKnownTheme(selection.themeId)) {
      const message = `Unknown theme '${selection.themeId}'.`;
      throw new ApiError(404, "theme_not_found", message);
    }
    store.writeSetting(db, personal(store.appearanceSetting), selection);
    hub.system(["config-changed"]);
    return c.json(knownTheme(selection));
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
    requireOwner(c, "Only an owner can change this bb's shared environment");
    await replaceMachineEnvironment(bb, null, payload);
    hub.system(["config-changed"]);
    return c.json(machineEnvironmentView(db));
  });

  get(projects.machineEnvironment, (c) => {
    const { id } = requireProject(db, c.req.param("id"));
    return c.json(projectMachineEnvironmentView(db, id));
  });

  put(projects.replaceMachineEnvironment, async (c, payload) => {
    const { id } = requireProject(db, c.req.param("id"));
    await replaceMachineEnvironment(bb, id, payload);
    hub.system(["config-changed"]);
    return c.json(projectMachineEnvironmentView(db, id));
  });
}
