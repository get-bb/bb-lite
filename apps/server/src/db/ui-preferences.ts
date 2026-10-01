import type { Db } from "./index.js";

export interface UiPreferenceRow {
  key: string;
  valueJson: string;
  revision: number;
}

export type UiPreferenceWrite =
  | { outcome: "updated"; revision: number }
  | { outcome: "conflict"; revision: number };

export function listUiPreferenceRows(db: Db): UiPreferenceRow[] {
  return db.all<UiPreferenceRow>(
    "SELECT key, value_json, revision FROM ui_preferences",
  );
}

export function writeUiPreferenceRow(
  db: Db,
  args: { key: string; valueJson: string; expectedRevision: number | null },
): UiPreferenceWrite {
  return db.transaction((): UiPreferenceWrite => {
    const stored = db.get<{ revision: number }>(
      "SELECT revision FROM ui_preferences WHERE key = ?",
      args.key,
    );
    const current = stored?.revision ?? 0;
    if (args.expectedRevision !== null && args.expectedRevision !== current) {
      return { outcome: "conflict", revision: current };
    }
    db.run(
      `INSERT INTO ui_preferences (key, value_json, revision, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE
       SET value_json = excluded.value_json,
           revision = excluded.revision,
           updated_at = excluded.updated_at`,
      args.key,
      args.valueJson,
      current + 1,
      db.now(),
    );
    return { outcome: "updated", revision: current + 1 };
  });
}
