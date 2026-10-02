import type { Db } from "./index.js";

export type PluginRowTable = "plugin_kv" | "plugin_settings";

export function isPluginEnabled(db: Db, id: string): boolean {
  const row = db.get<{ enabled: number }>(
    "SELECT enabled FROM plugins WHERE id = ?",
    id,
  );
  return row === undefined || row.enabled === 1;
}

export function setPluginEnabled(db: Db, id: string, enabled: boolean): void {
  db.run(
    `INSERT INTO plugins (id, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE
     SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
    id,
    enabled ? 1 : 0,
    db.now(),
    db.now(),
  );
}

export function readPluginRows(
  db: Db,
  table: PluginRowTable,
  pluginId: string,
  keyPrefix = "",
): Map<string, string> {
  const rows = db.all<{ key: string; value: string }>(
    `SELECT key, value FROM ${table}
     WHERE plugin_id = ? AND substr(key, 1, ?) = ? ORDER BY key`,
    pluginId,
    keyPrefix.length,
    keyPrefix,
  );
  return new Map(rows.map((row) => [row.key, row.value]));
}

export function writePluginRow(
  db: Db,
  table: PluginRowTable,
  pluginId: string,
  key: string,
  value: string | null,
): void {
  if (value === null) {
    const sql = `DELETE FROM ${table} WHERE plugin_id = ? AND key = ?`;
    db.run(sql, pluginId, key);
    return;
  }
  db.run(
    `INSERT INTO ${table} (plugin_id, key, value, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (plugin_id, key) DO UPDATE
     SET value = excluded.value, updated_at = excluded.updated_at`,
    pluginId,
    key,
    value,
    db.now(),
  );
}
