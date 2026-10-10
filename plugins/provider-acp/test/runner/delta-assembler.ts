import type { ThreadEvent } from "@bb/domain";
import { EventBuilder, type RunnerThreadEvent } from "@bb/runner";
import {
  createDeltaSink,
  type ThreadDelta,
} from "../../runner/thread-delta.js";

export interface DeltaAssembler {
  assemble(args: { threadId: string; deltas: ThreadDelta[] }): ThreadEvent[];
  getOpenTurnId(threadId: string): string | null;
}

export function createDeltaAssembler(options: {
  providerId: string;
  entropyPrefix: string;
  textDeltaFlushMs: number;
}): DeltaAssembler {
  const emitted: RunnerThreadEvent[] = [];
  const events = new EventBuilder({
    emit: (event) => emitted.push(event),
    textFlushMs: options.textDeltaFlushMs,
  });
  const sink = createDeltaSink(events);
  events.identity(`${options.providerId}-session`);
  emitted.length = 0;
  return {
    assemble({ threadId, deltas }) {
      sink.apply(deltas);
      events.flush();
      return emitted.splice(0).map((event) => {
        const located = threadId === "" ? {} : { threadId: "" };
        return { ...event, ...located, providerThreadId: "" } as ThreadEvent;
      });
    },
    getOpenTurnId: () => events.activeTurnId,
  };
}
