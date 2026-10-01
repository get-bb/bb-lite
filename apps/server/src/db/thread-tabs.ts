import type { Db } from "./index.js";

export interface StoredThreadTabs {
  revision: number;
  tabsJson: string;
}

export type ThreadTabsWrite =
  | { outcome: "updated"; revision: number }
  | { outcome: "conflict"; revision: number };

export function threadExists(db: Db, threadId: string): boolean {
  const thread = db.get(
    "SELECT 1 FROM threads WHERE id = ? AND deleted_at IS NULL",
    threadId,
  );
  return thread !== undefined;
}

export function readThreadTabs(
  db: Db,
  threadId: string,
): StoredThreadTabs | undefined {
  return db.get<StoredThreadTabs>(
    "SELECT revision, tabs_json FROM thread_tabs WHERE thread_id = ?",
    threadId,
  );
}

export function writeThreadTabs(
  db: Db,
  args: { threadId: string; tabsJson: string; expectedRevision: number },
): ThreadTabsWrite {
  return db.transaction((): ThreadTabsWrite => {
    const current = readThreadTabs(db, args.threadId)?.revision ?? 0;
    if (current !== args.expectedRevision) {
      return { outcome: "conflict", revision: current };
    }
    db.run(
      `INSERT INTO thread_tabs (thread_id, tabs_json, revision, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (thread_id) DO UPDATE
       SET tabs_json = excluded.tabs_json,
           revision = excluded.revision,
           updated_at = excluded.updated_at`,
      args.threadId,
      args.tabsJson,
      current + 1,
      db.now(),
    );
    return { outcome: "updated", revision: current + 1 };
  });
}
