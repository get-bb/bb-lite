import type { Db, SqlValue } from "./index.js";

export type RowPatch = Record<string, SqlValue | undefined>;

function snakeCase(key: string): string {
  return key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
}

export function updateRow(
  db: Db,
  table: string,
  id: string,
  patch: RowPatch,
): boolean {
  const columns: string[] = [];
  const values: SqlValue[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    columns.push(`${snakeCase(key)} = ?`);
    values.push(value);
  }
  const assignments = [...columns, "updated_at = ?"].join(", ");
  const sql = `UPDATE ${table} SET ${assignments} WHERE id = ?`;
  return db.run(sql, ...values, db.now(), id).changes > 0;
}
