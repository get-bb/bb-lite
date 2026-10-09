import { fail, threads } from "@bb/plugin";
import type { PromptInput } from "@bb/domain";
import type { ThreadResponse } from "@bb/server-contract";
import type { z } from "zod";
import { actorUserId, viewerId } from "@bb/server-kit/auth/actor";
import { latestSequence } from "@bb/server-kit/db/event-read";
import { getEnvironment } from "@bb/server-kit/db/environments";
import type { Db } from "@bb/server-kit/db/index";
import * as store from "@bb/server-kit/db/threads";
import type { Engine } from "./engine.js";
import type { StartupContext } from "./provisioning.js";

type ForkRequest = z.output<typeof threads.fork.input>;

const MAX_HISTORY_CHARS = 100_000;

interface HistoryRow {
  kind: "user_message" | "assistant_message";
  text: string;
}

function readHistory(db: Db, threadId: string, end: number) {
  return db.all<HistoryRow>(
    `SELECT source_kind AS kind, text FROM thread_search_segments
     WHERE thread_id = ? AND source_seq <= ?
       AND source_kind IN ('user_message', 'assistant_message')
     ORDER BY source_seq`,
    threadId,
    end,
  );
}

function historySeed(sourceThreadId: string, rows: HistoryRow[]): PromptInput {
  const lines = rows.map(
    ({ kind, text }) =>
      `${kind === "user_message" ? "User" : "Assistant"}: ${text}`,
  );
  let transcript = lines.join("\n\n");
  if (transcript.length > MAX_HISTORY_CHARS) {
    transcript = transcript.slice(-MAX_HISTORY_CHARS);
  }
  const text =
    `This conversation is a fork of thread ${sourceThreadId}. ` +
    `The conversation so far:\n\n${transcript}\n\n`;
  return { type: "text", text, mentions: [], visibility: "agent-only" };
}

function unavailable(message: string): never {
  return fail("unavailable", `Cannot fork: ${message}`, {
    reason: "fork_source_session_unavailable",
  });
}

export function forkThread(
  engine: Engine,
  request: ForkRequest,
  originPluginId: string | null,
): ThreadResponse {
  const { bb } = engine;
  const { db } = bb;
  const source = store.requireThread(db, request.sourceThreadId);
  const environment =
    source.environmentId === null
      ? undefined
      : getEnvironment(db, source.environmentId);
  if (environment === undefined || environment.status === "destroyed") {
    unavailable("source has no workspace to continue in");
  }
  const latest = latestSequence(db, source.id);
  const end = request.sourceSeqEnd ?? latest;
  if (end > latest) unavailable("sourceSeqEnd is past the source history");
  const history = readHistory(db, source.id, end);
  if (history.length === 0) unavailable("source has no conversation yet");
  const seed = [
    historySeed(source.id, history),
    ...(request.agentContextSeed ?? []),
  ];
  const startup: StartupContext = {
    intent: { type: "reuse", environmentId: environment.id },
    titleProvided: request.title !== undefined,
    seed,
  };
  const { projectId } = source;
  const thread = engine.commit((out) => {
    const row = store.insertThread(db, {
      projectId,
      providerId: source.providerId,
      model: source.model,
      reasoningLevel: source.reasoningLevel,
      permissionMode: source.permissionMode,
      serviceTier: source.serviceTier,
      title: request.title ?? null,
      titleFallback: source.title ?? source.titleFallback,
      sectionId: null,
      createdByUserId: actorUserId(),
      viewerId: viewerId(),
      startupContext: JSON.stringify(startup),
      parentThreadId: null,
      lifecycleOwnerThreadId: request.lifecycleOwnerThreadId ?? null,
      originPluginId,
      originKind: "fork",
      sourceThreadId: source.id,
      visibility: request.visibility ?? source.visibility,
      pinned: false,
    });
    out.thread(row.id, ["thread-created"], { projectId });
    out.project(projectId, ["threads-changed"]);
    const response = engine.respond(row.id);
    out.after(() => bb.emit(threads.created, { thread: response }));
    return row;
  });
  return engine.respond(thread.id);
}
