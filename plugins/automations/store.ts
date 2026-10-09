import type { PluginServerApi, SqlValue } from "@bb/plugin";
import { CronExpressionParser } from "cron-parser";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AgentExecution, Automation, Run, Trigger } from "./contract.js";

const AutomationRow = Automation.extend({
  enabled: z.number().transform(Boolean),
  trigger: z.string().transform((text) => Trigger.parse(JSON.parse(text))),
  execution: z
    .string()
    .transform((text) => AgentExecution.parse(JSON.parse(text))),
});

export function nextRunAt(trigger: Trigger, after: number): number | null {
  if (trigger.triggerType === "once") {
    return trigger.runAt > after ? trigger.runAt : null;
  }
  return CronExpressionParser.parse(trigger.cron, {
    currentDate: new Date(after),
    tz: trigger.timezone,
  })
    .next()
    .getTime();
}

export function validateTrigger(trigger: Trigger, now: number): string | null {
  if (trigger.triggerType === "once") {
    return trigger.runAt > now ? null : "runAt must be in the future";
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trigger.timezone });
  } catch {
    return `Unknown timezone: ${trigger.timezone}`;
  }
  try {
    nextRunAt(trigger, now);
    return null;
  } catch {
    return `Invalid cron expression: ${trigger.cron}`;
  }
}

export type NewAutomation = Pick<
  Automation,
  "projectId" | "name" | "enabled" | "trigger" | "execution" | "origin"
> & { createdByThreadId?: string };

export function openStore(bb: PluginServerApi) {
  const { tables } = bb.storage;
  const A = tables.name("automations");
  const R = tables.name("runs");
  tables.migrate([
    `CREATE TABLE ${A} (id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
      name TEXT NOT NULL, enabled INTEGER NOT NULL, trigger TEXT NOT NULL,
      execution TEXT NOT NULL, origin TEXT NOT NULL,
      created_by_thread_id TEXT, next_run_at INTEGER, last_run_at INTEGER,
      run_count INTEGER NOT NULL DEFAULT 0, last_run_status TEXT,
      last_run_thread_id TEXT, last_error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE INDEX ${A}_due ON ${A} (enabled, next_run_at)`,
    `CREATE TABLE ${R} (id TEXT PRIMARY KEY, automation_id TEXT NOT NULL,
      run_mode TEXT NOT NULL, thread_id TEXT, status TEXT NOT NULL,
      trigger TEXT NOT NULL, skip_reason TEXT, error TEXT, output TEXT,
      exit_code INTEGER, scheduled_for INTEGER NOT NULL,
      started_at INTEGER NOT NULL, finished_at INTEGER,
      idempotency_key TEXT)`,
    `CREATE INDEX ${R}_automation ON ${R} (automation_id, started_at)`,
    `CREATE INDEX ${R}_thread ON ${R} (thread_id, status)`,
  ]);
  const db = bb.db;
  const many = (sql: string, ...args: SqlValue[]) =>
    db.all(sql, ...args).map((row) => AutomationRow.parse(row));
  const one = (sql: string, ...args: SqlValue[]) => many(sql, ...args)[0];
  const run = (runId: string) =>
    Run.parse(db.get(`SELECT * FROM ${R} WHERE id = ?`, runId));

  return {
    list: (projectId: string) =>
      many(
        `SELECT * FROM ${A} WHERE project_id = ? ORDER BY created_at, id`,
        projectId,
      ),
    get: (projectId: string, automationId: string) =>
      one(
        `SELECT * FROM ${A} WHERE project_id = ? AND id = ?`,
        projectId,
        automationId,
      ),
    byId: (automationId: string) =>
      one(`SELECT * FROM ${A} WHERE id = ?`, automationId),
    due: (now: number) =>
      many(
        `SELECT * FROM ${A} WHERE enabled = 1 AND next_run_at <= ?
         ORDER BY next_run_at`,
        now,
      ),
    targeting: (threadId: string) =>
      many(
        `SELECT * FROM ${A} WHERE json_extract(execution, '$.targetThreadId') = ?`,
        threadId,
      ),
    insert(input: NewAutomation, now: number): string {
      const id = `aut_${randomUUID()}`;
      db.run(
        `INSERT INTO ${A} (id, project_id, name, enabled, trigger, execution,
          origin, created_by_thread_id, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.projectId,
        input.name,
        input.enabled ? 1 : 0,
        JSON.stringify(input.trigger),
        JSON.stringify(input.execution),
        input.origin,
        input.createdByThreadId ?? null,
        input.enabled ? nextRunAt(input.trigger, now) : null,
        now,
        now,
      );
      return id;
    },
    save(automation: Automation, now: number): void {
      db.run(
        `UPDATE ${A} SET name = ?, enabled = ?, trigger = ?, execution = ?,
          next_run_at = ?, updated_at = ? WHERE id = ?`,
        automation.name,
        automation.enabled ? 1 : 0,
        JSON.stringify(automation.trigger),
        JSON.stringify(automation.execution),
        automation.nextRunAt,
        now,
        automation.id,
      );
    },
    remove(automationId: string): void {
      db.transaction(() => {
        db.run(`DELETE FROM ${R} WHERE automation_id = ?`, automationId);
        db.run(`DELETE FROM ${A} WHERE id = ?`, automationId);
      });
    },
    running: (automationId: string) =>
      db.get(
        `SELECT id FROM ${R} WHERE automation_id = ? AND status = 'running'`,
        automationId,
      ) !== undefined,
    byKey(automationId: string, key: string): Run | undefined {
      const row = db.get(
        `SELECT id FROM ${R} WHERE automation_id = ? AND idempotency_key = ?`,
        automationId,
        key,
      );
      return row ? run(z.object({ id: z.string() }).parse(row).id) : undefined;
    },
    startRun(args: {
      automationId: string;
      trigger: Run["trigger"];
      scheduledFor: number;
      now: number;
      status?: Run["status"];
      skipReason?: string;
      idempotencyKey?: string;
    }): Run {
      const id = `run_${randomUUID()}`;
      const status = args.status ?? "running";
      db.transaction(() => {
        db.run(
          `INSERT INTO ${R} (id, automation_id, run_mode, status, trigger,
            skip_reason, scheduled_for, started_at, finished_at,
            idempotency_key) VALUES (?, ?, 'agent', ?, ?, ?, ?, ?, ?, ?)`,
          id,
          args.automationId,
          status,
          args.trigger,
          args.skipReason ?? null,
          args.scheduledFor,
          args.now,
          status === "running" ? null : args.now,
          args.idempotencyKey ?? null,
        );
        db.run(
          `UPDATE ${A} SET last_run_at = ?, last_run_status = ?,
            run_count = run_count + 1, updated_at = ? WHERE id = ?`,
          args.now,
          status,
          args.now,
          args.automationId,
        );
      });
      return run(id);
    },
    setThread(runId: string, automationId: string, threadId: string): void {
      db.run(`UPDATE ${R} SET thread_id = ? WHERE id = ?`, threadId, runId);
      db.run(
        `UPDATE ${A} SET last_run_thread_id = ? WHERE id = ?`,
        threadId,
        automationId,
      );
    },
    finish(
      runId: string,
      status: Run["status"],
      error: string | null,
      now: number,
    ): Run {
      const done = run(runId);
      db.run(
        `UPDATE ${R} SET status = ?, error = ?, finished_at = ? WHERE id = ?`,
        status,
        error,
        now,
        runId,
      );
      db.run(
        `UPDATE ${A} SET last_run_status = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
        status,
        error,
        now,
        done.automationId,
      );
      return run(runId);
    },
    openRunsOf: (threadId: string) =>
      db
        .all(
          `SELECT * FROM ${R} WHERE thread_id = ? AND status = 'running'`,
          threadId,
        )
        .map((row) => Run.parse(row)),
    runs: (automationId: string, limit: number) =>
      db
        .all(
          `SELECT * FROM ${R} WHERE automation_id = ?
           ORDER BY started_at DESC, id DESC LIMIT ?`,
          automationId,
          limit,
        )
        .map((row) => Run.parse(row)),
  };
}

export type Store = ReturnType<typeof openStore>;
