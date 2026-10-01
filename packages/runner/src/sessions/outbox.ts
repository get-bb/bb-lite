import type {
  RunnerEvent,
  RunnerEventSink,
  RunnerThreadEvent,
} from "../types.js";

type Reliable = Extract<RunnerEvent, { lane: "reliable" }>;
type Unsequenced = Reliable extends infer E
  ? E extends unknown
    ? Omit<E, "lane" | "seq">
    : never
  : never;

const MAX_UNACKED = 10_000;

function flushesImmediately(event: RunnerThreadEvent) {
  switch (event.type) {
    case "turn/started":
    case "turn/completed":
    case "item/completed":
    case "system/error":
      return true;
    case "provider/error":
      return event.willRetry !== true;
    default:
      return false;
  }
}

export class Outbox {
  private seq = 0;
  private acked = 0;
  private unacked: Reliable[] = [];
  private batch: { threadId: string; events: RunnerThreadEvent[] }[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sink: RunnerEventSink,
    private readonly flushMs = 100,
  ) {}

  get lastSeq() {
    return this.seq;
  }

  get lastAckedSeq() {
    return this.acked;
  }

  threadEvent(threadId: string, event: RunnerThreadEvent) {
    const tail = this.batch.at(-1);
    if (tail?.threadId === threadId) tail.events.push(event);
    else this.batch.push({ threadId, events: [event] });
    if (flushesImmediately(event)) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), this.flushMs).unref();
  }

  emit(event: Unsequenced) {
    this.flush();
    this.deliver(event);
  }

  flush() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    for (const group of this.batch.splice(0)) {
      this.deliver({ kind: "thread.events", ...group });
    }
  }

  ack(seq: number) {
    this.acked = Math.max(this.acked, seq);
    this.unacked = this.unacked.filter((event) => event.seq > seq);
  }

  resendAfter(seq: number) {
    for (const event of this.unacked) if (event.seq > seq) this.send(event);
  }

  private deliver(event: Unsequenced) {
    this.seq += 1;
    const sequenced: Reliable = { ...event, lane: "reliable", seq: this.seq };
    this.unacked.push(sequenced);
    if (this.unacked.length > MAX_UNACKED) this.unacked.shift();
    this.send(sequenced);
  }

  private send(event: Reliable) {
    try {
      this.sink(event);
    } catch {
      return;
    }
  }
}
