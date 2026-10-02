import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { pruneSupersededDeltas } from "../src/db/events.js";
import { createTestServer } from "./helpers.js";
import { insertRow, type SeedRow } from "./thread-seed.js";

interface ThreadFixture {
  thread: SeedRow & { id: string; parent_thread_id: string | null };
  events: (SeedRow & { type: string; data: string })[];
  interactions: SeedRow[];
}

type Json = null | boolean | number | string | Json[] | JsonObject;
interface JsonObject {
  [key: string]: Json;
}

const fixturesDir = process.env.BB_FIXTURES_DIR ?? "";
const goldenDir = join(fixturesDir, "golden");
const DIFFERENCE_LIMIT = 6;
const PER_THREAD_GOLDENS = [
  ["timeline", "/timeline"],
  ["timeline-nested", "/timeline?includeNestedRows=true"],
  ["thread", "?include=environment,host"],
  ["output", "/output"],
  ["exec", "/default-execution-options"],
  ["interactions", "/interactions"],
  ["prompt-history", "/prompt-history"],
];
const SHARED_GOLDENS = [
  { file: "sidebar-bootstrap.json", path: "/sidebar-bootstrap" },
  { file: "threads-list.json", path: "/threads" },
  { file: "search.json", path: "/threads/search?query=claude%20models" },
];

const CUT_ROUTES = ["/system/attention", "/threads/count"];

function readJson<T>(path: string) {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function isObject(value: Json): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function differences(mine: Json, theirs: Json, path = "$"): string[] {
  if (JSON.stringify(mine) === JSON.stringify(theirs)) return [];
  const nested =
    (isObject(mine) && isObject(theirs)) ||
    (Array.isArray(mine) && Array.isArray(theirs));
  if (!nested) {
    const show = (value: Json) => JSON.stringify(value).slice(0, 120);
    return [`${path}: ${show(mine)} != ${show(theirs)}`];
  }
  const left = mine as JsonObject;
  const right = theirs as JsonObject;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  const side = (from: JsonObject, key: string): Json =>
    key in from ? (from[key] ?? null) : "<absent>";
  return [...keys]
    .flatMap((key) =>
      differences(side(left, key), side(right, key), `${path}.${key}`),
    )
    .slice(0, DIFFERENCE_LIMIT);
}

function lastExecution(events: ThreadFixture["events"]): SeedRow {
  const requests = events.filter(
    (event) => event.type === "client/turn/requested",
  );
  const { execution } = JSON.parse(requests.at(-1)?.data ?? "{}") as {
    execution?: Record<string, string>;
  };
  return {
    model: execution?.model,
    reasoning_level: execution?.reasoningLevel,
    permission_mode: execution?.permissionMode,
    service_tier: execution?.serviceTier,
  };
}

function snakeCased(row: JsonObject) {
  const entries = Object.entries(row).map(([key, value]) => [
    key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`),
    typeof value === "boolean" ? Number(value) : value,
  ]);
  return Object.fromEntries(entries) as SeedRow;
}

describe.skipIf(!existsSync(goldenDir))("original server equivalence", () => {
  test("serves what the original served for the exported threads", async () => {
    const golden = (name: string): Json => readJson(join(goldenDir, name));
    const fixtures = readdirSync(join(fixturesDir, "threads")).map((file) =>
      readJson<ThreadFixture>(join(fixturesDir, "threads", file)),
    );
    const threadIds = fixtures.map((fixture) => fixture.thread.id);
    const sidebar = golden("sidebar-bootstrap.json") as {
      projects: [JsonObject & { id: string; sources: [JsonObject] }];
      personalProject: JsonObject;
    };
    const [project] = sidebar.projects;
    const detail = golden(`${threadIds[0]}.thread.json`) as {
      environment: JsonObject & { id: string };
      host: JsonObject & { id: string };
    };
    const { environment, host } = detail;
    const server = await createTestServer({ hostId: host.id });
    const { db } = server.ctx;
    const selection = JSON.stringify(environment.environmentProviderSelection);
    insertRow(db, "hosts", snakeCased(host));
    insertRow(db, "projects", { ...snakeCased(project), sources: undefined });
    insertRow(db, "projects", snakeCased(sidebar.personalProject));
    insertRow(db, "project_sources", snakeCased(project.sources[0]));
    insertRow(db, "environments", {
      ...snakeCased(environment),
      environment_provider_selection: selection,
      lifecycle: undefined,
    });
    db.transaction(() => {
      for (const { thread, events, interactions } of fixtures) {
        const parent = thread.parent_thread_id ?? "";
        insertRow(db, "threads", {
          ...thread,
          ...lastExecution(events),
          project_id: project.id,
          environment_id: environment.id,
          archived_at: null,
          section_id: null,
          parent_thread_id: threadIds.includes(parent) ? parent : null,
          source_thread_id: null,
          lifecycle_owner_thread_id: null,
          status: thread.status === "error" ? "error" : "idle",
          startup_context: null,
        });
        for (const event of events) {
          insertRow(db, "events", { ...event, environment_id: environment.id });
          if (event.type !== "item/completed") continue;
          pruneSupersededDeltas(db, thread.id, String(event.item_id));
        }
        for (const row of interactions)
          insertRow(db, "pending_interactions", row);
      }
    });

    const retainedOutputCalls = new Set(
      fixtures.flatMap(({ events }) =>
        events.flatMap((event) =>
          event.data.includes('"truncation":{') ? [event.item_id] : [],
        ),
      ),
    );
    const withoutRetainedOutputPreviews = (value: Json): Json => {
      if (Array.isArray(value)) return value.map(withoutRetainedOutputPreviews);
      if (!isObject(value)) return value;
      const kept = Object.entries(value).filter(
        ([key]) =>
          key !== "outputPreview" || !retainedOutputCalls.has(value.callId),
      );
      return Object.fromEntries(
        kept.map(([key, inner]) => [key, withoutRetainedOutputPreviews(inner)]),
      );
    };
    const requestedRowOnly = (path: string, body: Json) => {
      const range = /Start=(\d+)&sourceSeqEnd=(\d+)$/u.exec(path);
      const rows = isObject(body) && Array.isArray(body.rows) ? body.rows : [];
      const requested = rows.flatMap((row) => {
        if (!isObject(row) || range === null) return [];
        const { sourceSeqStart, sourceSeqEnd, completedAt: _at, ...rest } = row;
        const [, start, end] = range.map(Number);
        return sourceSeqStart === start && sourceSeqEnd === end ? [rest] : [];
      });
      return requested.length === 0 ? body : requested;
    };
    const mismatches: string[] = [];
    const perThread = threadIds.flatMap((threadId) =>
      PER_THREAD_GOLDENS.map(([suffix, path]) => ({
        file: `${threadId}.${suffix}.json`,
        path: `/threads/${threadId}${path}`,
      })),
    );
    const extraManifest = join(goldenDir, "extra.json");
    const extras = existsSync(extraManifest)
      ? readJson<typeof SHARED_GOLDENS>(extraManifest)
      : [];
    const recorded = [...perThread, ...SHARED_GOLDENS, ...extras].filter(
      ({ path }) => !CUT_ROUTES.some((route) => path.startsWith(route)),
    );
    for (const { file, path } of recorded) {
      const response = await fetch(`${server.url}/api/v1${path}`);
      const served = response.status === 204 ? null : await response.json();
      const mine = requestedRowOnly(path, served as Json);
      const original = withoutRetainedOutputPreviews(golden(file));
      const found = differences(mine, requestedRowOnly(path, original));
      mismatches.push(...found.map((difference) => `${path} ${difference}`));
    }
    console.log(`${recorded.length} recorded responses compared`);
    expect(mismatches).toEqual([]);
  }, 300_000);
});
