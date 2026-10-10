import { fail } from "@bb/plugin";
import type { PromptInput } from "@bb/domain";
import * as pending from "@bb/server-kit/db/pending-interactions";
import * as store from "@bb/server-kit/db/threads";
import { findProviderDefinition } from "@bb/server-kit/providers/catalog";
import type { Engine } from "./engine.js";
import * as mutations from "./mutations.js";
import { rewindPoint } from "./session-spec.js";

function unsupported(message: string): never {
  return fail("unavailable", `Cannot edit this message: ${message}`, {
    reason: "rewind_unsupported",
  });
}

export async function editMessage(
  engine: Engine,
  threadId: string,
  seq: number,
  input: PromptInput[],
) {
  const { db, runners } = engine.bb;
  const thread = engine.requireThread(threadId);
  const provider = findProviderDefinition(db, thread.providerId);
  if (provider?.info.capabilities.fork !== "checkpoint") {
    unsupported("the thread's provider cannot rewind its session");
  }
  const busy = thread.status !== "idle" && thread.status !== "error";
  if (busy || pending.hasTurnBoundInteraction(db, threadId)) {
    fail("conflict", "Wait for the running turn before editing a message");
  }
  const request = db.get(
    `SELECT 1 FROM events WHERE thread_id = ? AND sequence = ?
       AND type = 'client/turn/requested'`,
    threadId,
    seq,
  );
  if (request === undefined) {
    fail("not_found", `No message at seq ${seq} in this thread`);
  }
  if (rewindPoint(db, threadId, seq) === null) {
    unsupported("no provider checkpoint exists before it");
  }
  const hostId = engine.connectedHostOf(thread);
  if (hostId !== null) {
    await runners.get(hostId).releaseSession({ threadId });
  }
  engine.commit((out) => {
    db.run(
      "DELETE FROM events WHERE thread_id = ? AND sequence >= ?",
      threadId,
      seq,
    );
    db.run(
      `DELETE FROM thread_search_segments
       WHERE thread_id = ? AND source_seq >= ?`,
      threadId,
      seq,
    );
    db.run(
      `DELETE FROM prompt_history_entries
       WHERE thread_id = ? AND request_sequence >= ?`,
      threadId,
      seq,
    );
    store.patchThread(db, threadId, { providerThreadId: null }, false);
    const metadata = engine.statusMetadata(threadId);
    out.thread(threadId, ["history-rewritten", "status-changed"], metadata);
  });
  return mutations.send(engine, threadId, { input, mode: "start" });
}
