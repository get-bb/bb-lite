import { OpError, threads, type PluginServerApi } from "@bb/plugin";
import type { Thread } from "@bb/domain";
import type { TimelineRow } from "@bb/server-contract";
import { z } from "zod";
import { sideChat } from "./contract.js";

export const REPLY_SEED_PREFIX =
  "Replying to this earlier message in the conversation:\n\n";
export const EMPTY_FORK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const EMPTY_FORK_SWEEP_PAGE_SIZE = 100;
const KEPT = "kept-fork:";
const RETRY_MS = 60 * 60 * 1000;

type Outcome = "archived" | "kept" | "skipped";

function hasUserMessage(rows: readonly TimelineRow[]): boolean {
  return rows.some((row) =>
    row.kind === "conversation"
      ? row.role === "user"
      : row.kind === "turn" && hasUserMessage(row.children ?? []),
  );
}

function sessionUnavailable(error: unknown) {
  return (
    error instanceof OpError &&
    error.reason === "fork_source_session_unavailable"
  );
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export default function sideChatServer(bb: PluginServerApi) {
  const db = bb.storage.database([
    `CREATE TABLE cleanup_candidates (thread_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, due_at INTEGER NOT NULL);
     CREATE INDEX cleanup_candidates_due_idx ON cleanup_candidates(due_at);
     CREATE TABLE cleanup_discovery (id INTEGER PRIMARY KEY);`,
  ]);
  const ownLiveFork = (thread: Thread) =>
    thread.originKind === "fork" &&
    thread.originPluginId === bb.pluginId &&
    thread.visibility === "hidden" &&
    thread.archivedAt === null;
  const enqueue = (threadId: string, createdAt: number) => {
    db.prepare(
      "INSERT OR IGNORE INTO cleanup_candidates (thread_id, created_at, due_at) VALUES (?, ?, ?)",
    ).run(threadId, createdAt, createdAt + EMPTY_FORK_MAX_AGE_MS + 1);
  };
  const dequeue = (threadId: string) =>
    db
      .prepare("DELETE FROM cleanup_candidates WHERE thread_id=?")
      .run(threadId);

  for (const event of [threads.archived, threads.deleted]) {
    bb.on(event, async ({ thread }) => {
      dequeue(thread.id);
      await bb.storage.kv.delete(`${KEPT}${thread.id}`);
    });
  }
  bb.on(threads.unarchived, ({ thread }) => {
    if (ownLiveFork(thread)) enqueue(thread.id, thread.createdAt);
  });

  bb.implement(sideChat.create, async (input) => {
    const { sourceThreadId, sourceSeqEnd } = input;
    const anchor = input.anchorText.trim();
    const seed =
      anchor === ""
        ? {}
        : {
            agentContextSeed: [
              {
                type: "text" as const,
                text: `${REPLY_SEED_PREFIX}${anchor}`,
                mentions: [],
                visibility: "agent-only" as const,
              },
            ],
          };
    const args = {
      sourceThreadId,
      lifecycleOwnerThreadId: sourceThreadId,
      visibility: "hidden" as const,
      ...seed,
    };
    const fork = await bb
      .call(threads.fork, { ...args, sourceSeqEnd })
      .catch((error: unknown) => {
        if (sourceSeqEnd === undefined || !sessionUnavailable(error)) {
          throw error;
        }
        return bb.call(threads.fork, args);
      });
    enqueue(fork.id, fork.createdAt);
    return { threadId: fork.id };
  });

  async function sweep(threadId: string, createdAt: number): Promise<Outcome> {
    const step = async <T>(what: string, run: () => Promise<T>) =>
      run().catch((error: unknown) => {
        bb.log.warn(
          `empty-fork sweep skipped ${threadId} (${what} failed: ${errorText(error)})`,
        );
        return null;
      });
    const thread = await step("thread read", () =>
      bb.call(threads.get, { threadId }),
    );
    if (thread === null) return "skipped";
    if (!ownLiveFork(thread)) return "kept";
    const timeline = await step("timeline read", () =>
      bb.call(threads.timeline, { threadId, includeNestedRows: true }),
    );
    if (timeline === null) return "skipped";
    if (hasUserMessage(timeline.rows)) return "kept";
    const queued = await step("queued-message read", () =>
      bb.call(threads.listQueuedMessages, { threadId }),
    );
    if (queued === null) return "skipped";
    if (queued.length > 0) return "kept";
    const archived = await step("archive", () =>
      bb.call(threads.archive, { threadId }),
    );
    if (archived === null) return "skipped";
    bb.log.info(
      `empty-fork sweep archived ${threadId} (no user messages, created ${new Date(createdAt).toISOString()})`,
    );
    return "archived";
  }

  async function sweepDue(now: number) {
    const due = z
      .array(z.object({ threadId: z.string(), createdAt: z.number() }))
      .parse(
        db
          .prepare(
            `SELECT thread_id AS threadId, created_at AS createdAt FROM cleanup_candidates WHERE due_at <= ? ORDER BY due_at LIMIT ${EMPTY_FORK_SWEEP_PAGE_SIZE}`,
          )
          .all(now),
      );
    for (const { threadId, createdAt } of due) {
      if ((await sweep(threadId, createdAt)) !== "skipped") dequeue(threadId);
      else
        db.prepare(
          "UPDATE cleanup_candidates SET due_at=? WHERE thread_id=?",
        ).run(now + RETRY_MS, threadId);
    }
  }

  async function discover(now: number) {
    const keptKeys = new Set(await bb.storage.kv.list(KEPT));
    const stillLive = new Set<string>();
    for (let offset = 0; ;) {
      const page = await bb.call(threads.list, {
        includeHidden: true,
        originKind: "fork",
        originPluginId: bb.pluginId,
        archived: false,
        limit: EMPTY_FORK_SWEEP_PAGE_SIZE,
        offset,
      });
      let retained = 0;
      for (const thread of page) {
        const key = `${KEPT}${thread.id}`;
        retained += 1;
        if (!ownLiveFork(thread)) continue;
        if (now - thread.createdAt <= EMPTY_FORK_MAX_AGE_MS) {
          enqueue(thread.id, thread.createdAt);
        } else if (keptKeys.has(key)) {
          stillLive.add(key);
        } else {
          const outcome = await sweep(thread.id, thread.createdAt);
          if (outcome === "archived") retained -= 1;
          if (outcome === "skipped") enqueue(thread.id, thread.createdAt);
          if (outcome === "kept") {
            await bb.storage.kv.set(key, true);
            stillLive.add(key);
          }
        }
      }
      if (page.length < EMPTY_FORK_SWEEP_PAGE_SIZE) break;
      offset += retained;
    }
    for (const key of keptKeys) {
      if (!stillLive.has(key)) await bb.storage.kv.delete(key);
    }
    db.prepare("INSERT INTO cleanup_discovery VALUES (1)").run();
  }

  async function cleanup() {
    const now = bb.now();
    const discovered = db
      .prepare("SELECT id FROM cleanup_discovery WHERE id=1")
      .get();
    await (discovered === undefined ? discover(now) : sweepDue(now));
  }

  bb.background.schedule("empty-fork-cleanup", "13 * * * *", cleanup);
}
