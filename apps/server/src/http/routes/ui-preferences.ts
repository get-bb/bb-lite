import {
  getUiPreferenceDefault,
  isUiPreferenceKey,
  parseUiPreferenceValue,
  UI_PREFERENCE_KEYS,
  type UiPreferenceEntries,
  type UiPreferenceEntry,
  type UiPreferenceKey,
} from "@bb/domain";
import { publicApiRoutes } from "@bb/server-contract";
import type { ServerContext } from "../../context.js";
import { encodeJson, type Db } from "../../db/index.js";
import {
  listUiPreferenceRows,
  writeUiPreferenceRow,
  type UiPreferenceRow,
} from "../../db/ui-preferences.js";
import { typedApi, type ApiApp } from "../api.js";
import { ApiError, invalidRequest } from "../errors.js";

function requireUiPreferenceKey(key: string): UiPreferenceKey {
  if (isUiPreferenceKey(key)) return key;
  throw new ApiError(
    404,
    "ui_preference_not_found",
    `Unknown UI preference '${key}'. Known preferences: ` +
      `${UI_PREFERENCE_KEYS.join(", ")}.`,
  );
}

function toEntry<Key extends UiPreferenceKey>(
  key: Key,
  row: UiPreferenceRow | undefined,
): UiPreferenceEntry<Key> {
  const fallback = getUiPreferenceDefault(key);
  if (row === undefined) return { revision: 0, value: fallback };
  const stored = parseUiPreferenceValue(key, JSON.parse(row.valueJson));
  const value = stored.success ? stored.value : fallback;
  return { revision: row.revision, value };
}

function readUiPreferences(db: Db): UiPreferenceEntries {
  const rows = new Map(listUiPreferenceRows(db).map((row) => [row.key, row]));
  return Object.fromEntries(
    UI_PREFERENCE_KEYS.map((key) => [key, toEntry(key, rows.get(key))]),
  ) as UiPreferenceEntries;
}

export function registerUiPreferenceRoutes(
  app: ApiApp,
  ctx: ServerContext,
): void {
  const { del, get, put } = typedApi(app);
  const routes = publicApiRoutes.system;

  get(routes.uiPreferences, (c) =>
    c.json({ preferences: readUiPreferences(ctx.db) }),
  );

  put(routes.updateUiPreference, (c, payload) => {
    const key = requireUiPreferenceKey(c.req.param("key"));
    const parsed = parseUiPreferenceValue(key, payload.value);
    if (!parsed.success) {
      throw invalidRequest(
        `Invalid value for UI preference '${key}': ${parsed.message}`,
      );
    }
    const written = writeUiPreferenceRow(ctx.db, {
      key,
      valueJson: encodeJson(parsed.value),
      expectedRevision: payload.expectedRevision,
    });
    if (written.outcome === "conflict") {
      throw new ApiError(
        409,
        "ui_preference_conflict",
        "UI preference changed on another client",
        { details: { currentRevision: written.revision } },
      );
    }
    ctx.hub.system(["ui-preferences-changed"]);
    return c.json({ key, revision: written.revision, value: parsed.value });
  });

  del(routes.resetUiPreference, (c) => {
    const key = requireUiPreferenceKey(c.req.param("key"));
    const value = getUiPreferenceDefault(key);
    const { revision } = writeUiPreferenceRow(ctx.db, {
      key,
      valueJson: encodeJson(value),
      expectedRevision: null,
    });
    ctx.hub.system(["ui-preferences-changed"]);
    return c.json({ key, revision, value });
  });
}
