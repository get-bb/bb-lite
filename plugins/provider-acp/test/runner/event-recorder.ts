import type { ThreadEvent } from "@bb/domain";
import { EventBuilder, type RunnerThreadEvent } from "@bb/runner";

export interface EventRecorder {
  events: EventBuilder;
  collect(action: () => void): ThreadEvent[];
}

export function createEventRecorder(options: {
  providerId: string;
  textDeltaFlushMs: number;
}): EventRecorder {
  const emitted: RunnerThreadEvent[] = [];
  const events = new EventBuilder({
    emit: (event) => emitted.push(event),
    textFlushMs: options.textDeltaFlushMs,
  });
  events.identity(`${options.providerId}-session`);
  emitted.length = 0;
  return {
    events,
    collect(action) {
      action();
      events.flush();
      return emitted.splice(0).map(
        (event) =>
          ({
            ...event,
            threadId: "",
            providerThreadId: "",
          }) as ThreadEvent,
      );
    },
  };
}
