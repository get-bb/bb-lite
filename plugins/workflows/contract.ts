import { contract, op } from "@bb/plugin";
import { z } from "zod";

export const runStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const callStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

const runIdField = z.string().min(1).describe("Workflow run id");

export const runSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  originThreadId: z.string().nullable(),
  environmentId: z.string().nullable(),
  name: z.string(),
  description: z.string(),
  status: runStatusSchema,
  phase: z.string().nullable(),
  resumedFromRunId: z.string().nullable(),
  result: z.unknown(),
  error: z.string().nullable(),
  calls: z.record(z.string(), z.number()),
  originProviderId: z.string().nullable(),
  settings: z.record(z.string(), z.number()),
  notification: z.object({
    status: z.enum(["pending", "sent", "failed"]).nullable(),
    attempts: z.number(),
    error: z.string().nullable(),
  }),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
});
export type WorkflowRun = z.infer<typeof runSchema>;

export const callSchema = z.object({
  index: z.number(),
  label: z.string(),
  phase: z.string().nullable(),
  prompt: z.string(),
  threadId: z.string().nullable(),
  status: callStatusSchema,
  cached: z.boolean(),
  attempts: z.number(),
  result: z.unknown(),
  error: z.string().nullable(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
});
export type WorkflowCall = z.infer<typeof callSchema>;

const sourceFields = {
  script: z
    .string()
    .min(1)
    .describe(
      "Self-contained workflow script. Must begin with `export const meta = { name, description, phases }` (pure literal, no computed values) followed by the script body using agent()/parallel()/pipeline()/phase().",
    )
    .optional(),
  source: z
    .string()
    .min(1)
    .describe("Alias for `script`. Do not provide both `source` and `script`.")
    .optional(),
  scriptPath: z
    .string()
    .min(1)
    .describe(
      "Path to a workflow script file on the origin environment's host. Relative paths start at the workspace root and all paths must remain inside that workspace.",
    )
    .optional(),
  name: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .max(64)
    .describe(
      "Name of a saved workflow from the current workspace's .bb/workflows/ directory.",
    )
    .optional(),
  threadId: z
    .string()
    .min(1)
    .describe(
      "Thread the workflow belongs to; the CLI fills it from the agent terminal it runs in",
    )
    .optional(),
  cwd: z
    .string()
    .min(1)
    .describe(
      "Directory a relative scriptPath starts from; the CLI fills it with its working directory",
    )
    .optional(),
};

const sourceCli = {
  flags: {
    scriptPath: { aliases: ["file"] },
    resumeRunId: { aliases: ["resume"] },
  },
  from: { threadId: "threadId", cwd: "cwd" },
} as const;

export const workflows = contract("workflows", {
  create: op({
    input: z
      .object({
        ...sourceFields,
        args: z
          .unknown()
          .describe(
            "Optional input value exposed to the script as the global `args`, verbatim. Pass arrays/objects as actual JSON values, NOT as a JSON-encoded string.",
          )
          .optional(),
        resumeRunId: z
          .string()
          .min(1)
          .nullable()
          .describe(
            "Run ID of a prior BB workflow to resume from. Calls in the longest unchanged prefix return cached results; the first edited or new call and everything after it run live. The prior run must be terminal and from the same project.",
          )
          .optional(),
      })
      .strict(),
    output: z.object({
      runId: z.string(),
      status: runStatusSchema,
      name: z.string(),
      previewDirective: z.string(),
    }),
    kind: "write",
    doors: {
      cli: {
        path: "workflows run",
        summary: "Start a workflow and return immediately",
        ...sourceCli,
      },
      agent: {
        name: "bb_workflow_run",
        description:
          "Execute a workflow script that orchestrates multiple subagents deterministically. Workflows run in the background — this tool returns immediately with a run ID and a `previewDirective`. After a successful call, emit that directive exactly once on its own line (not in a code fence) so BB renders live progress in chat. A completion notification is sent to the origin thread. Use `bb workflows status <run-id>` for a compact summary. For detailed history, redirect a bounded JSONL page from `bb workflows history <run-id> --cursor <call-index> --limit <1-100>` into `$BB_THREAD_STORAGE`, then inspect the file with normal filesystem tools.",
        presentation: {
          label: {
            pending: "Starting workflow",
            completed: "Started workflow",
          },
          icon: { glyph: "Workflow" },
        },
      },
    },
  }),
  validate: op({
    input: z.object(sourceFields).strict(),
    output: z.object({
      name: z.string(),
      description: z.string(),
      phases: z.array(z.string()),
    }),
    doors: {
      cli: {
        path: "workflows validate",
        summary: "Check a workflow's source and metadata without running it",
        flags: sourceCli.flags,
        from: sourceCli.from,
      },
    },
  }),
  get: op({
    input: z.object({ runId: runIdField }),
    output: runSchema,
    doors: {
      cli: {
        path: "workflows status",
        summary: "Show a compact summary of a workflow run",
        positionals: ["runId"],
      },
    },
  }),
  list: op({
    input: z.object({
      threadId: z.string().optional().describe("Only runs started here"),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("Most recent runs to include"),
    }),
    output: z.array(runSchema),
    doors: {
      cli: { path: "workflows list", summary: "List workflow runs" },
    },
  }),
  history: op({
    input: z.object({
      runId: runIdField,
      cursor: z.coerce
        .number()
        .int()
        .min(0)
        .default(0)
        .describe(
          "First call index to include; use a page record's nextCursor to continue",
        ),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("How many calls to include in this page"),
    }),
    output: z.object({
      run: runSchema,
      calls: z.array(callSchema),
      nextCursor: z.number().nullable(),
    }),
    doors: {
      cli: {
        path: "workflows history",
        summary: "Read one JSONL page of workflow run and call history",
        positionals: ["runId"],
        print: (page) =>
          [
            { type: "run", ...page.run },
            ...page.calls.map((call) => ({ type: "call", ...call })),
            { type: "page", nextCursor: page.nextCursor },
          ]
            .map((record) => JSON.stringify(record))
            .join("\n"),
      },
    },
  }),
  result: op({
    input: z.object({
      value: z
        .unknown()
        .describe("The structured value matching the required schema"),
    }),
    output: z.string(),
    kind: "write",
    doors: {
      agent: {
        name: "bb_workflow_result",
        description:
          "Submit this workflow call's structured result. Call it exactly once at the end of your response with { value } matching the JSON Schema in your prompt.",
      },
    },
  }),
  stop: op({
    input: z.object({ runId: runIdField }),
    output: z.object({ stopped: z.boolean(), run: runSchema }),
    kind: "write",
    doors: {
      cli: {
        path: "workflows stop",
        summary: "Stop a queued or running workflow",
        positionals: ["runId"],
      },
    },
  }),
});
