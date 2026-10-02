import { insertRow, type Db } from "./index.js";

export type PluginRowTable = "plugin_kv" | "plugin_settings";

export function isPluginEnabled(db: Db, id: string): boolean {
  const row = db.get<{ enabled: number }>(
    "SELECT enabled FROM plugins WHERE id = ?",
    id,
  );
  return row === undefined || row.enabled === 1;
}

export function setPluginEnabled(db: Db, id: string, enabled: boolean): void {
  const at = { createdAt: db.now(), updatedAt: db.now() };
  insertRow(db, "plugins", { id, enabled: Number(enabled), ...at }, ["id"]);
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
  const row = { pluginId, key, value, updatedAt: db.now() };
  insertRow(db, table, row, ["plugin_id", "key"]);
}
