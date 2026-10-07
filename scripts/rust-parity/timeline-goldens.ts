import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildThreadTimelineFromEvents,
  compactThreadTimelineSummaryEvents,
  type ThreadEventWithMeta,
} from "../../packages/thread-view/src/index.js";
import { buildEventProjection } from "../../packages/thread-view/src/build-event-projection.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const out = join(root, "crates/bb-thread-view/tests/fixtures/timeline");
const THREAD_ID = "thr_fixture000";
const BASE_TIME = 1_790_000_000_000;

const OPTION_SETS = [
  {
    completedTurnDisplay: "collapse",
    includeDiagnosticOperations: false,
    includeNestedRows: false,
    isLatestPage: true,
    threadStatus: "idle",
    threadName: "Fixture thread",
    workspaceRoot: "/tmp/bb-recording-ws",
  },
  {
    completedTurnDisplay: "flat",
    includeDiagnosticOperations: true,
    includeNestedRows: true,
    isLatestPage: true,
    threadStatus: "active",
    threadName: "Fixture thread",
    workspaceRoot: null,
  },
  {
    completedTurnDisplay: "collapse",
    includeDiagnosticOperations: false,
    includeNestedRows: true,
    isLatestPage: false,
    threadStatus: "error",
    threadName: "Fixture thread",
    workspaceRoot: "/tmp/bb-recording-ws",
  },
] as const;

function withMeta(events: unknown[]): ThreadEventWithMeta[] {
  return events.map((event, index) => ({
    event: { ...(event as object), threadId: THREAD_ID },
    meta: {
      id: `evt_${String(index + 1).padStart(6, "0")}`,
      seq: index + 1,
      createdAt: BASE_TIME + index * 250,
    },
  })) as ThreadEventWithMeta[];
}

function sources(): { name: string; events: unknown[] }[] {
  const found: { name: string; events: unknown[] }[] = [];
  for (const provider of ["claude", "codex"]) {
    const dir = join(root, "packages/runner/test/fixtures", provider);
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith(".events.json")) continue;
      const name = `${provider}-${file.replace(".events.json", "")}`;
      const events = JSON.parse(readFileSync(join(dir, file), "utf8"));
      found.push({ name, events });
    }
  }
  const raw = join(root, "crates/bb-claude/tests/fixtures/raw");
  for (const scenario of readdirSync(raw).sort()) {
    let recorded: unknown;
    try {
      recorded = JSON.parse(
        readFileSync(join(raw, scenario, "events.json"), "utf8"),
      );
    } catch {
      continue;
    }
    const batches = (recorded as { kind?: string; events?: unknown[] }[])
      .filter((entry) => entry.kind === "thread.events")
      .flatMap((entry) => entry.events ?? []);
    if (batches.length > 0) {
      found.push({ name: `claude-raw-${scenario}`, events: batches });
    }
  }
  return found;
}

mkdirSync(out, { recursive: true });
let cases = 0;
for (const { name, events } of sources()) {
  const decoded = withMeta(events);
  const contextWindowEvents = decoded.filter(
    ({ event }) => event.type === "thread/contextWindow/updated",
  );
  const results = OPTION_SETS.map((options) => {
    const input = compactThreadTimelineSummaryEvents(decoded);
    cases += 1;
    return {
      options,
      projection: buildEventProjection(input, options),
      expected: buildThreadTimelineFromEvents({
        contextWindowEvents,
        headStateEvents: [],
        events: input,
        options,
      }),
    };
  });
  const compacted = compactThreadTimelineSummaryEvents(decoded);
  const body = { name, events: decoded, compacted, contextWindowEvents, results };
  writeFileSync(join(out, `${name}.json`), JSON.stringify(body));
}
console.log(`wrote ${cases} cases to ${out}`);
