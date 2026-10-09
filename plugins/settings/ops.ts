import { readFile } from "node:fs/promises";
import * as domain from "@bb/domain";
import {
  appearance as appearanceSlots,
  projects,
  server,
  settings,
  type PluginServerApi,
} from "@bb/plugin";
import type {
  ServerAccessStatus,
  SystemConfigResponse,
} from "@bb/server-contract";
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
import { transcriberAvailable } from "@bb/server-kit/providers/inference";
import { ApiError, invalidRequest } from "@bb/server-kit/http/errors";
import { requestOrigin, requireOwner } from "@bb/server-kit/http/trust";

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

export function implementSettings(bb: PluginServerApi): void {
  const { db, realtime: hub } = bb;
  const personal = <T>(setting: store.Setting<T>) =>
    store.userSetting(setting, viewerId());
  const declared = () =>
    bb.entries(appearanceSlots.theme).map(({ item }) => item);
  const themes = () => declared().map(({ cssFile: _file, ...theme }) => theme);
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

  bb.implement(server.experiments, () => ({
    flags: { ...bb.server.experiments },
  }));

  bb.implement(server.config, async (): Promise<SystemConfigResponse> => {
    const generalSettings = store.getAppSettings(db);
    const keybindingOverrides = store.readSetting(
      db,
      personal(store.keybindingOverridesSetting),
    );
    const publicUrl = publicServerUrl(bb);
    return {
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
      serverUrl: publicUrl ?? requestOrigin() ?? bb.server.url,
      primaryHostId: defaultHostId(bb),
      primaryHostPlatform: serverPlatform(),
      dataDir: bb.server.dataDir,
      voiceTranscriptionEnabled: await transcriberAvailable(bb),
    };
  });

  bb.implement(settings.updateGeneral, (input) => {
    requireOwner("Only an owner can change this bb's general settings");
    const { showUnhandledProviderEvents: _legacy, ...changes } = input.settings;
    const stored = store.getAppSettings(db);
    const updated = domain.appSettingsSchema.parse({ ...stored, ...changes });
    store.setAppSettings(db, updated);
    hub.system(["config-changed"]);
    return updated;
  });

  bb.implement(settings.updateKeyboard, ({ overrides }) => {
    const setting = personal(store.keybindingOverridesSetting);
    store.writeSetting(db, setting, overrides);
    hub.system(["config-changed"]);
    return overrides;
  });

  bb.implement(settings.updateAppearance, (selection) => {
    if (!isKnownTheme(selection.themeId)) {
      const message = `Unknown theme '${selection.themeId}'.`;
      throw new ApiError(404, "theme_not_found", message);
    }
    store.writeSetting(db, personal(store.appearanceSetting), selection);
    hub.system(["config-changed"]);
    const chosen = knownTheme(selection);
    bb.emit(appearanceSlots.changed, chosen);
    bb.changed(server.config);
    return chosen;
  });

  bb.implement(appearanceSlots.themeCss, async ({ themeId }) => {
    if (domain.isBuiltInThemeId(themeId)) {
      return { css: domain.builtInThemeCss[themeId] };
    }
    const theme = declared().find(({ id }) => id === themeId);
    const css = await readFile(theme?.cssFile ?? "", "utf8").catch(() => null);
    if (css === null) {
      const message = `Unknown theme '${themeId}'.`;
      throw new ApiError(404, "theme_not_found", message);
    }
    return { css };
  });

  bb.implement(settings.uiPreferences, () => ({
    preferences: readUiPreferences(db),
  }));

  bb.implement(settings.updateUiPreference, (input) => {
    const key = requireUiPreferenceKey(input.key);
    const parsed = domain.parseUiPreferenceValue(key, input.value);
    if (!parsed.success) {
      throw invalidRequest(
        `Invalid value for UI preference '${key}': ${parsed.message}`,
      );
    }
    const { value } = parsed;
    const revision = writeUiPreference(db, key, value, input.expectedRevision);
    hub.system(["ui-preferences-changed"]);
    return { key, revision, value };
  });

  bb.implement(settings.resetUiPreference, (input) => {
    const key = requireUiPreferenceKey(input.key);
    const value = domain.getUiPreferenceDefault(key);
    const revision = writeUiPreference(db, key, value, null);
    hub.system(["ui-preferences-changed"]);
    return { key, revision, value };
  });

  bb.implement(settings.machineEnvironment, () => machineEnvironmentView(db));

  bb.implement(settings.updateMachineEnvironment, async (replacement) => {
    requireOwner("Only an owner can change this bb's shared environment");
    await replaceMachineEnvironment(bb, null, replacement);
    hub.system(["config-changed"]);
    return machineEnvironmentView(db);
  });

  bb.implement(projects.machineEnvironment, ({ projectId }) => {
    const { id } = requireProject(db, projectId);
    return projectMachineEnvironmentView(db, id);
  });

  bb.implement(
    projects.updateMachineEnvironment,
    async ({ projectId, ...replacement }) => {
      requireOwner("Only an owner can change a project's shared environment");
      const { id } = requireProject(db, projectId);
      await replaceMachineEnvironment(bb, id, replacement);
      hub.system(["config-changed"]);
      return projectMachineEnvironmentView(db, id);
    },
  );
}
