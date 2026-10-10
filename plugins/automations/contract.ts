import { contract, event, op } from "@bb/plugin";
import { createThreadEnvironmentArgsSchema } from "@bb/server-contract";
import {
  permissionModeSchema,
  reasoningLevelSchema,
  serviceTierSchema,
} from "@bb/domain";
import { z } from "zod";

export const RUNS_LIMIT_DEFAULT = 50;
export const RUNS_LIMIT_MAX = 200;

export const Trigger = z.discriminatedUnion("triggerType", [
  z.object({
    triggerType: z.literal("schedule"),
    cron: z.string().min(1).max(200),
    timezone: z.string().min(1).max(100),
  }),
  z.object({
    triggerType: z.literal("once"),
    runAt: z.number().int().positive(),
  }),
]);
export type Trigger = z.infer<typeof Trigger>;

export const AgentExecution = z.object({
  mode: z.literal("agent"),
  prompt: z.string().min(1),
  providerId: z.string().min(1),
  model: z.string().min(1),
  reasoningLevel: reasoningLevelSchema.default("medium"),
  serviceTier: serviceTierSchema.optional(),
  permissionMode: permissionModeSchema,
  environment: createThreadEnvironmentArgsSchema,
  targetThreadId: z.string().min(1).optional(),
});
export type AgentExecution = z.infer<typeof AgentExecution>;

export const SCRIPT_TIMEOUT_DEFAULT_MS = 120_000;
export const SCRIPT_TIMEOUT_MAX_MS = 900_000;
export const INTERPRETERS = ["bash", "sh", "node", "python3"] as const;

export const WorkingDirectory = z.discriminatedUnion("type", [
  z.object({ type: z.literal("automation-storage") }),
  z.object({ type: z.literal("project") }),
  z.object({ type: z.literal("path"), path: z.string().min(1).max(4096) }),
]);
export type WorkingDirectory = z.infer<typeof WorkingDirectory>;

export const ScriptExecution = z.object({
  mode: z.literal("script"),
  script: z.string().min(1).max(262_144),
  scriptFile: z.string().min(1).max(200).optional(),
  hostId: z.string().min(1).optional(),
  interpreter: z.enum(INTERPRETERS).optional(),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(SCRIPT_TIMEOUT_MAX_MS)
    .default(SCRIPT_TIMEOUT_DEFAULT_MS),
  env: z.record(z.string(), z.string()).optional(),
  workingDirectory: WorkingDirectory.default({ type: "automation-storage" }),
});
export type ScriptExecution = z.infer<typeof ScriptExecution>;

export const Execution = z.discriminatedUnion("mode", [
  AgentExecution,
  ScriptExecution,
]);
export type Execution = z.infer<typeof Execution>;

export const ScriptResult = z.object({
  exitCode: z.number().int().nullable(),
  output: z.string(),
  stderr: z.string(),
  timedOut: z.boolean(),
});
export type ScriptResult = z.infer<typeof ScriptResult>;

export const RunStatus = z.enum(["running", "succeeded", "failed", "skipped"]);

export const Automation = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  trigger: Trigger,
  execution: Execution,
  origin: z.enum(["human", "app", "agent"]),
  createdByThreadId: z.string().nullable(),
  nextRunAt: z.number().nullable(),
  lastRunAt: z.number().nullable(),
  runCount: z.number().int(),
  lastRunStatus: RunStatus.nullable(),
  lastRunThreadId: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Automation = z.infer<typeof Automation>;

export const Run = z.object({
  id: z.string(),
  automationId: z.string(),
  runMode: z.enum(["agent", "script"]),
  threadId: z.string().nullable(),
  status: RunStatus,
  trigger: z.enum(["schedule", "manual"]),
  skipReason: z.string().nullable(),
  error: z.string().nullable(),
  output: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  scheduledFor: z.number(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
});
export type Run = z.infer<typeof Run>;

const project = z.object({ projectId: z.string().min(1) });
const ref = project.extend({ automationId: z.string().min(1) });
const name = z.string().trim().min(1).max(200);

export const automations = contract("automations", {
  list: op({ input: project, output: z.array(Automation) }),
  get: op({ input: ref, output: Automation }),
  create: op({
    input: project.extend({
      name,
      enabled: z.boolean().default(true),
      trigger: Trigger,
      execution: Execution,
      origin: z.enum(["human", "app", "agent"]).default("app"),
      createdByThreadId: z.string().min(1).optional(),
    }),
    output: Automation,
    kind: "write",
  }),
  update: op({
    input: ref.extend({
      name: name.optional(),
      trigger: Trigger.optional(),
      execution: Execution.optional(),
    }),
    output: Automation,
    kind: "write",
  }),
  pause: op({ input: ref, output: Automation, kind: "write" }),
  resume: op({ input: ref, output: Automation, kind: "write" }),
  delete: op({ input: ref, output: z.void(), kind: "write" }),
  run: op({
    input: ref.extend({
      idempotencyKey: z.string().min(1).max(200).optional(),
    }),
    output: z.object({ run: Run }),
    kind: "write",
  }),
  runs: op({
    input: ref.extend({
      limit: z.number().int().min(1).max(RUNS_LIMIT_MAX).optional(),
      cursor: z.string().regex(/^\d+$/u).optional(),
    }),
    output: z.object({ runs: z.array(Run), nextCursor: z.string().nullable() }),
  }),
  runScript: op({
    input: z.object({
      script: z.string().min(1),
      interpreter: z.enum(INTERPRETERS),
      timeoutMs: z.number().int().positive().max(SCRIPT_TIMEOUT_MAX_MS),
      env: z.record(z.string(), z.string()).default({}),
      cwd: z.string().min(1).nullable(),
    }),
    output: ScriptResult,
    kind: "write",
    audit: false,
    internal: true,
  }),
  changed: event(z.object({ projectId: z.string(), automationId: z.string() })),
});
