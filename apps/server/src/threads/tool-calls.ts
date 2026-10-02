import type { ToolCallResponse } from "@bb/domain";
import { z } from "zod";
import { getThread, patchThread, type ThreadRow } from "../db/threads.js";
import type { RunnerEventOf } from "../runners/registry.js";
import { errorMessage } from "./core.js";
import { sessionEnvironmentOf } from "./dispatch.js";
import type { Engine } from "./engine.js";
import {
  pluginContext,
  UPDATE_ENVIRONMENT_DIRECTORY_TOOL,
} from "./session-spec.js";

type ToolCallEvent = RunnerEventOf<"toolCall.requested">;

const directoryInputSchema = z
  .object({ path: z.string().trim().min(1) })
  .strict();

function reply(success: boolean, text: string): ToolCallResponse {
  return { success, contentItems: [{ type: "inputText", text }] };
}

async function updateEnvironmentDirectory(
  engine: Engine,
  thread: ThreadRow,
  input: unknown,
  signal: AbortSignal,
): Promise<ToolCallResponse> {
  const { db, environments } = engine.ctx;
  const parsed = directoryInputSchema.safeParse(input);
  if (!parsed.success) return reply(false, "Provide the directory as `path`.");
  const path = parsed.data.path.replace(/(?<=.)\/+$/u, "");
  if (!path.startsWith("/") || path === "/") {
    return reply(false, "Path must be an absolute directory on this host.");
  }
  const { hostId } = sessionEnvironmentOf(engine, thread);
  const target = await environments.ensureForThread({
    thread,
    intent: {
      type: "provider",
      environmentProviderId: "project-checkout",
      hostId,
      inputs: { path },
    },
    onProgress: () => {},
    signal,
  });
  const { environmentId } = target;
  return engine.inThread(thread.id, () => {
    const current = getThread(db, thread.id);
    if (current === undefined || current.deletedAt !== null) {
      return reply(false, "Cannot move a deleted thread.");
    }
    if (current.archivedAt !== null) {
      return reply(false, "Cannot move an archived thread.");
    }
    if (current.environmentId !== environmentId) {
      environments.onThreadDetached(thread.id);
      engine.commit((out) => {
        patchThread(db, thread.id, { environmentId });
        const { projectId } = current;
        out.thread(thread.id, ["environment-changed"], { projectId });
      });
    }
    return reply(
      true,
      `Environment directory updated to ${target.path}. This applies to ` +
        "future turns; stop work in this turn so the next turn can run " +
        "from the updated directory.",
    );
  });
}

async function runTool(
  engine: Engine,
  event: ToolCallEvent,
  signal: AbortSignal,
): Promise<ToolCallResponse> {
  const { db, plugins } = engine.ctx;
  const { arguments: input, tool } = event;
  const thread = getThread(db, event.threadId);
  if (thread === undefined) return reply(false, "Thread not found.");
  if (tool === UPDATE_ENVIRONMENT_DIRECTORY_TOOL.name) {
    return updateEnvironmentDirectory(engine, thread, input, signal);
  }
  const scope = pluginContext(db, thread, engine.hostOf(thread));
  return plugins.callTool(tool, input, { ...scope, signal });
}

export function startToolCall(
  engine: Engine,
  hostId: string,
  event: ToolCallEvent,
): void {
  const { requestId, threadId } = event;
  if (engine.toolCalls.has(requestId)) return;
  const abort = new AbortController();
  engine.toolCalls.set(requestId, abort);
  const settled = runTool(engine, event, abort.signal)
    .catch((error: unknown) => reply(false, errorMessage(error)))
    .then((result) =>
      engine.ctx.runners
        .get(hostId)
        .resolveToolCall({ threadId, requestId, result }),
    )
    .finally(() => engine.toolCalls.delete(requestId));
  engine.background("tool call", settled);
}

export function cancelToolCall(engine: Engine, requestId: string): void {
  engine.toolCalls.get(requestId)?.abort();
}
