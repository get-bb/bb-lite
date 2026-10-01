import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createTestServer } from "./helpers.js";
import { insertRow, type SeedRow } from "./thread-seed.js";

interface ThreadFixture {
  thread: SeedRow & { id: string; parent_thread_id: string | null };
  events: (SeedRow & { type: string; data: string })[];
  interactions: SeedRow[];
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const fixturesDir = process.env.BB_FIXTURES_DIR ?? "";
const goldenDir = join(fixturesDir, "golden");
const DIFFERENCE_LIMIT = 6;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function golden(name: string): Json {
  return readJson<Json>(join(goldenDir, name));
}

function differences(mine: Json, theirs: Json, path = "$"): string[] {
  if (JSON.stringify(mine) === JSON.stringify(theirs)) return [];
  const comparable =
    typeof mine === "object" &&
    typeof theirs === "object" &&
    mine !== null &&
    theirs !== null &&
    Array.isArray(mine) === Array.isArray(theirs);
  if (!comparable) {
    const show = (value: Json): string =>
      (JSON.stringify(value) ?? "undefined").slice(0, 120);
    return [`${path}: ${show(mine)} != ${show(theirs)}`];
  }
  const left = mine as Record<string, Json>;
  const right = theirs as Record<string, Json>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  const absent = "<absent>";
  return [...keys]
    .flatMap((key) =>
      differences(
        key in left ? (left[key] as Json) : absent,
        key in right ? (right[key] as Json) : absent,
        `${path}.${key}`,
      ),
    )
    .slice(0, DIFFERENCE_LIMIT);
}

function countRows(rows: Json): number {
  if (!Array.isArray(rows)) return 0;
  return rows.reduce<number>((count, row) => {
    const nested = row as { children?: Json; childRows?: Json };
    const inner = countRows(nested.children ?? nested.childRows ?? null);
    return count + 1 + inner;
  }, 0);
}

function lastExecution(events: ThreadFixture["events"]): SeedRow {
  const requests = events.filter(
    (event) => event.type === "client/turn/requested",
  );
  const request = requests.at(-1);
  if (request === undefined) return {};
  const { execution } = JSON.parse(request.data) as {
    execution: Record<string, string>;
  };
  return {
    model: execution.model,
    reasoning_level: execution.reasoningLevel,
    permission_mode: execution.permissionMode,
    service_tier: execution.serviceTier,
  };
}

function withoutSupersededDeltas(
  events: ThreadFixture["events"],
): ThreadFixture["events"] {
  const completed = new Set(
    events.flatMap((event) =>
      event.type === "item/completed" ? [event.item_id] : [],
    ),
  );
  const kept = new Set<string>();
  return events.filter((event) => {
    const superseded =
      /delta$/iu.test(event.type) && completed.has(event.item_id);
    const key = `${String(event.item_id)} ${event.type}`;
    if (!superseded || !kept.has(key)) return kept.add(key);
    return false;
  });
}

describe.skipIf(!existsSync(goldenDir))("original server equivalence", () => {
  test("serves what the original served for the exported threads", async () => {
    const server = await createTestServer();
    const { db } = server.ctx;
    const fixtures = readdirSync(join(fixturesDir, "threads")).map((file) =>
      readJson<ThreadFixture>(join(fixturesDir, "threads", file)),
    );
    const threadIds = new Set(fixtures.map((fixture) => fixture.thread.id));
    const sidebar = golden("sidebar-bootstrap.json") as {
      projects: [{ id: string; sources: [Record<string, Json>] }];
      personalProject: Record<string, Json>;
    };
    const [project] = sidebar.projects;
    const [source] = project.sources;
    const detail = golden(`${fixtures[0]?.thread.id}.thread.json`) as {
      environment: Record<string, Json>;
      host: Record<string, Json> & { id: string };
    };
    const snake = (row: Record<string, Json>): SeedRow =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`),
          typeof value === "boolean" ? Number(value) : value,
        ]),
      );
    const environment = snake(detail.environment);
    insertRow(db, "hosts", snake(detail.host));
    server.ctx.runners.connect(detail.host.id, () => server.runner.api);
    insertRow(db, "projects", { ...snake(project), sources: undefined });
    insertRow(db, "projects", snake(sidebar.personalProject));
    insertRow(db, "project_sources", { ...snake(source), owns_path: 0 });
    insertRow(db, "environments", {
      ...environment,
      environment_provider_selection: JSON.stringify(
        detail.environment.environmentProviderSelection,
      ),
      lifecycle: undefined,
    });
    db.transaction(() => {
      for (const { thread, events: logged, interactions } of fixtures) {
        const events = withoutSupersededDeltas(logged);
        const parent = thread.parent_thread_id ?? "";
        insertRow(db, "threads", {
          ...thread,
          ...lastExecution(events),
          project_id: project.id,
          environment_id: environment.id,
          archived_at: null,
          section_id: null,
          parent_thread_id: threadIds.has(parent) ? parent : null,
          source_thread_id: null,
          lifecycle_owner_thread_id: null,
          status: thread.status === "error" ? "error" : "idle",
          startup_context: null,
        });
        for (const event of events) {
          insertRow(db, "events", { ...event, environment_id: environment.id });
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
      if (typeof value !== "object" || value === null) return value;
      if (Array.isArray(value)) return value.map(withoutRetainedOutputPreviews);
      const kept = Object.entries(value).filter(
        ([key]) =>
          key !== "outputPreview" || !retainedOutputCalls.has(value.callId),
      );
      return Object.fromEntries(
        kept.map(([key, inner]) => [key, withoutRetainedOutputPreviews(inner)]),
      );
    };
    const mismatches: string[] = [];
    const compare = async (name: string, path: string): Promise<Json> => {
      const response = await fetch(`${server.url}/api/v1${path}`);
      const mine = response.status === 204 ? null : await response.json();
      const theirs = withoutRetainedOutputPreviews(golden(name));
      const found = differences(mine as Json, theirs);
      mismatches.push(...found.map((difference) => `${path} ${difference}`));
      return mine as Json;
    };
    const report: Record<string, { rows: number; nestedRows: number }> = {};
    for (const threadId of threadIds) {
      const base = `/threads/${threadId}`;
      const timeline = (await compare(
        `${threadId}.timeline.json`,
        `${base}/timeline`,
      )) as { rows: Json };
      const nested = (await compare(
        `${threadId}.timeline-nested.json`,
        `${base}/timeline?includeNestedRows=true`,
      )) as { rows: Json };
      report[threadId] = {
        rows: countRows(timeline.rows),
        nestedRows: countRows(nested.rows),
      };
      await compare(
        `${threadId}.thread.json`,
        `${base}?include=environment,host`,
      );
      await compare(`${threadId}.outline.json`, `${base}/conversation-outline`);
      await compare(`${threadId}.output.json`, `${base}/output`);
      await compare(
        `${threadId}.exec.json`,
        `${base}/default-execution-options`,
      );
      await compare(`${threadId}.interactions.json`, `${base}/interactions`);
      await compare(
        `${threadId}.prompt-history.json`,
        `${base}/prompt-history`,
      );
    }
    await compare("sidebar-bootstrap.json", "/sidebar-bootstrap");
    await compare("threads-list.json", "/threads");
    await compare("search.json", "/threads/search?query=claude%20models");
    const extraManifest = join(goldenDir, "extra.json");
    const extras = existsSync(extraManifest)
      ? readJson<{ path: string; file: string }[]>(extraManifest)
      : [];
    for (const extra of extras) await compare(extra.file, extra.path);
    console.table(report);
    console.log(`${extras.length} further recorded responses compared`);
    expect(mismatches).toEqual([]);
  }, 120_000);
});
