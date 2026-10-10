import { conflict } from "../http/errors.js";
import type { Db, RowValues } from "./index.js";
import { orderKeyBetween } from "./order-keys.js";

export interface ThreadUserState {
  lastReadAt: number | null;
  pinnedAt: number | null;
  pinSortKey: string | null;
  sectionId: string | null;
}

export const VIEWER_LAST_READ_AT = `CASE
    WHEN s.thread_id IS NOT NULL THEN s.last_read_at
    WHEN threads.created_by_user_id IS (SELECT id FROM viewer)
      THEN threads.created_at
    WHEN threads.created_by_user_id IS NULL
      AND (SELECT id FROM viewer) = 'usr_owner' THEN threads.created_at
    ELSE threads.latest_attention_at END`;

const COLUMNS: Record<keyof ThreadUserState, string> = {
  lastReadAt: "last_read_at",
  pinnedAt: "pinned_at",
  pinSortKey: "pin_sort_key",
  sectionId: "section_id",
};

function ensureThreadUserState(db: Db, threadId: string, userId: string) {
  db.run(
    `WITH viewer (id) AS (SELECT @userId)
     INSERT INTO thread_user_state (thread_id, user_id, last_read_at)
     SELECT threads.id, @userId, ${VIEWER_LAST_READ_AT}
     FROM threads LEFT JOIN thread_user_state AS s ON 0
     WHERE threads.id = @threadId
     ON CONFLICT DO NOTHING`,
    { threadId, userId },
  );
}

export function getThreadUserState(
  db: Db,
  threadId: string,
  userId: string,
): ThreadUserState | undefined {
  return db.get<ThreadUserState>(
    `SELECT last_read_at, pinned_at, pin_sort_key, section_id
     FROM thread_user_state WHERE thread_id = ? AND user_id = ?`,
    threadId,
    userId,
  );
}

export function setThreadUserState(
  db: Db,
  threadId: string,
  userId: string,
  patch: Partial<ThreadUserState>,
): void {
  const keys = Object.keys(patch) as (keyof ThreadUserState)[];
  if (keys.length === 0) return;
  const sets = keys.map((key) => `${COLUMNS[key]} = @${key}`).join(", ");
  const values: RowValues = { ...patch, threadId, userId };
  db.transaction(() => {
    ensureThreadUserState(db, threadId, userId);
    db.run(
      `UPDATE thread_user_state SET ${sets}
       WHERE thread_id = @threadId AND user_id = @userId`,
      values,
    );
  });
}

export function nextPinSortKey(db: Db, userId: string): string {
  const first = db.get<{ key: string | null }>(
    `SELECT MIN(pin_sort_key) AS key FROM thread_user_state
     WHERE user_id = ? AND pinned_at IS NOT NULL`,
    userId,
  );
  return orderKeyBetween(null, first?.key ?? null);
}

export function reorderPinnedThread(
  db: Db,
  userId: string,
  id: string,
  previousThreadId: string | null,
  nextThreadId: string | null,
): void {
  const stale = conflict("Pinned order changed");
  const keyOf = (threadId: string | null) => {
    if (threadId === null) return null;
    const key = getThreadUserState(db, threadId, userId)?.pinSortKey ?? null;
    if (threadId === id || key === null) throw stale;
    return key;
  };
  if (getThreadUserState(db, id, userId)?.pinnedAt == null) {
    throw conflict("Thread is not pinned");
  }
  const previous = keyOf(previousThreadId);
  const next = keyOf(nextThreadId);
  if (previous !== null && next !== null && previous >= next) throw stale;
  const pinSortKey = orderKeyBetween(previous, next);
  setThreadUserState(db, id, userId, { pinSortKey });
}
