import { plugins } from "@bb/plugin";
import type { ToolCallResponse } from "@bb/domain";
import { runAs } from "@bb/server-kit/auth/actor";
import { getThread } from "@bb/server-kit/db/threads";
import { errorMessage } from "@bb/server-kit/http/errors";
import { agentActor } from "@bb/server-kit/runners/access";
import type { RunnerEventOf } from "@bb/server-kit/runners/registry";
import type { Engine } from "./engine.js";
import { pluginContext } from "./session-spec.js";

type ToolCallEvent = RunnerEventOf<"toolCall.requested">;

function reply(success: boolean, text: string): ToolCallResponse {
  return { success, contentItems: [{ type: "inputText", text }] };
}

async function runTool(
  engine: Engine,
  event: ToolCallEvent,
  signal: AbortSignal,
): Promise<ToolCallResponse> {
  const { db } = engine.ctx;
  const { arguments: input, tool } = event;
  const thread = getThread(db, event.threadId);
  if (thread === undefined) return reply(false, "Thread not found.");
  const scope = pluginContext(db, thread, engine.hostOf(thread));
  const actor = agentActor(db, event.threadId);
  const call = { name: tool, input, context: scope };
  return runAs(actor, () =>
    engine.ctx.call(plugins.callAgentTool, call, { signal }),
  );
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
