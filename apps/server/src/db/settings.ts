import * as domain from "@bb/domain";
import type { ZodType } from "zod";
import { insertRow, type Db } from "./index.js";

export interface Setting<T> {
  key: string;
  schema: ZodType<T>;
  fallback: T;
}

export const keybindingOverridesSetting: Setting<domain.AppKeybindingOverrides> =
  {
    key: "keybindingOverrides",
    schema: domain.appKeybindingOverridesSchema,
    fallback: [],
  };

export const appearanceSetting: Setting<domain.AppThemeSelection> = {
  key: "appearance",
  schema: domain.appThemeSelectionSchema,
  fallback: { themeId: "default", faviconColor: "default" },
};

const generalSetting: Setting<Partial<domain.AppSettings>> = {
  key: "general",
  schema: domain.appSettingsSchema.partial().strip(),
  fallback: {},
};

export function readSetting<T>(db: Db, setting: Setting<T>): T {
  const row = db.get<{ value: string }>(
    "SELECT value FROM settings WHERE key = ?",
    setting.key,
  );
  if (row === undefined) return setting.fallback;
  const stored = setting.schema.safeParse(JSON.parse(row.value));
  return stored.success ? stored.data : setting.fallback;
}

export function writeSetting<T>(db: Db, setting: Setting<T>, value: T): void {
  const { key } = setting;
  const row = { key, value: JSON.stringify(value), updatedAt: db.now() };
  insertRow(db, "settings", row, ["key"]);
}

export function getAppSettings(db: Db): domain.AppSettings {
  return { ...domain.defaultAppSettings, ...readSetting(db, generalSetting) };
}

export function setAppSettings(db: Db, settings: domain.AppSettings): void {
  writeSetting(db, generalSetting, settings);
}
