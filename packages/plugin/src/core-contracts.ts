import * as Domain from "@bb/domain";
import type * as Contract from "@bb/server-contract";
import { z } from "zod";
import { contract, event, op, service, slot } from "./contract.js";
import type { KernelInspection } from "./kernel.js";
import type {
  EnvironmentDefinition,
  FileReadArgs,
  FileWriteArgs,
  InferenceService,
  InputRequest,
  InputResult,
  MachineAccessProvider,
  MentionProvider,
  PluginEvents,
  ProviderEnvEntry,
} from "./server-api.js";

const threadContextSchema = z.object({
  threadId: z.string(),
  projectId: z.string(),
  hostId: z.string().nullable(),
  providerId: z.string(),
  providerCapabilities: z.custom<Domain.ProviderCapabilities>().optional(),
});

export interface ProviderToggle {
  label: string;
  description: string;
  default: boolean;
  option: string;
  inverted?: true;
}

export interface ProviderDeclaration {
  id: string;
  displayName: string;
  completedTurnDisplay: Domain.ProviderInfo["completedTurnDisplay"];
  logo: Uint8Array | null;
  reasoningLevels: Domain.ReasoningLevel[];
  composerCommands: "goal"[];
  capabilities: Omit<
    Domain.ProviderInfo["capabilities"],
    "permissionModes" | "modelCatalogScope"
  >;
  optional: Pick<
    Domain.ProviderInfo,
    "strings" | "serviceTiers" | "extensionKinds"
  >;
  settings?: Record<string, ProviderToggle>;
}

export type TitleFallback = (
  task: string,
  signal: AbortSignal,
) => Promise<string | null>;

const instructionSectionSchema = z.object({
  source: z.string(),
  text: z.string(),
});
export type InstructionSection = z.infer<typeof instructionSectionSchema>;

const threadRef = z.object({ threadId: z.string() });
const ROW_KIND = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const nothing = z.void();
const none = z.object({});
const threadWrite = () =>
  op({
    input: threadRef.extend({ args: z.array(z.unknown()) }),
    output: z.unknown(),
    kind: "write",
    hooks: "answer",
    internal: true,
  });
export type ThreadWriteOp = ReturnType<typeof threadWrite>;
const payload = <Name extends keyof PluginEvents>() =>
  event(z.custom<PluginEvents[Name]>());

const auditEntrySchema = z.object({
  id: z.number(),
  at: z.number(),
  op: z.string(),
  kind: z.string(),
  userId: z.string().nullable(),
  role: z.string(),
  door: z.string(),
  threadId: z.string().nullable(),
  via: z.array(z.string()),
  hooks: z.array(z.object({ plugin: z.string(), action: z.string() })),
  outcome: z.string(),
  detail: z.string().nullable(),
  durationMs: z.number(),
  input: z.string().nullable(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

const AUDIT_PAGE_LIMIT = 500;

export const audit = contract("audit", {
  list: op({
    input: z.object({
      user: z.string().optional(),
      op: z.string().optional(),
      thread: z.string().optional(),
      plugin: z.string().optional(),
      before: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(AUDIT_PAGE_LIMIT).default(100),
    }),
    output: z.array(auditEntrySchema),
    hooks: "observe",
  }),
});

export const sessions = contract("sessions", {
  instructions: op({
    input: threadContextSchema,
    output: z.array(instructionSectionSchema),
  }),
  env: op({
    input: threadContextSchema,
    output: z.array(z.custom<ProviderEnvEntry>()),
  }),
  mention: slot<MentionProvider>(),
  inference: slot<InferenceService>(),
  provider: slot<ProviderDeclaration>({ key: "id" }),
  titleFallback: service<TitleFallback>(),
});

export const threads = contract("threads", {
  create: op({
    input: z.custom<Contract.CreateThreadRequest>(),
    output: z.custom<Contract.ThreadResponse>(),
    kind: "write",
    hooks: "answer",
    internal: true,
  }),
  send: op({
    input: threadRef.extend({
      request: z.custom<Contract.SendMessageRequest>(),
    }),
    output: z.custom<Contract.SendMessageResponse>(),
    kind: "write",
    hooks: "answer",
    internal: true,
  }),
  stop: op({ input: threadRef, output: nothing, kind: "write" }),
  archive: op({
    input: threadRef,
    output: z.array(z.string()),
    kind: "write",
  }),
  unarchive: op({ input: threadRef, output: nothing, kind: "write" }),
  delete: op({
    input: threadRef.extend({ childThreadsConfirmed: z.boolean() }),
    output: nothing,
    kind: "write",
    hooks: "answer",
  }),
  get: op({
    input: threadRef,
    output: z.custom<Contract.ThreadResponse>().nullable(),
  }),
  list: op({
    input: z.custom<Contract.ThreadListQuery>(),
    output: z.custom<Contract.ThreadListResponse>(),
    internal: true,
  }),
  output: op({ input: threadRef, output: z.string().nullable() }),
  events: op({
    input: threadRef.extend({ after: z.number().optional() }),
    output: z.array(z.custom<Domain.ThreadEvent>()),
  }),
  addRow: op({
    input: threadRef.extend({
      kind: z.string().regex(ROW_KIND),
      title: z.string().min(1),
      detail: z.string().optional(),
      status: z.enum(["pending", "completed", "error"]).default("completed"),
      data: Domain.jsonValueSchema.default(null),
      id: z.string().min(1).optional(),
    }),
    output: z.object({ id: z.string() }),
    kind: "write",
    internal: true,
  }),
  update: threadWrite(),
  compact: threadWrite(),
  clearContext: threadWrite(),
  queueMessage: threadWrite(),
  editQueuedMessage: threadWrite(),
  dropQueuedMessage: threadWrite(),
  sendQueuedMessage: threadWrite(),
  created: payload<"thread.created">(),
  active: payload<"thread.active">(),
  idle: payload<"thread.idle">(),
  failed: payload<"thread.failed">(),
  archived: payload<"thread.archived">(),
  unarchived: payload<"thread.unarchived">(),
  deleted: payload<"thread.deleted">(),
});

export const interactions = contract("interactions", {
  pending: payload<"interaction.pending">(),
  ask: op({
    input: z.custom<InputRequest>(),
    output: z.custom<InputResult>(),
    kind: "write",
    internal: true,
  }),
  resolve: threadWrite(),
  respond: threadWrite(),
  cancel: threadWrite(),
});

export const files = contract("files", {
  read: op({
    input: z.custom<FileReadArgs>(),
    output: z.object({ content: z.string(), sha256: z.string() }).nullable(),
    internal: true,
  }),
  write: op({
    input: z.custom<FileWriteArgs>(),
    output: z.union([
      z.object({ outcome: z.literal("written"), sha256: z.string() }),
      z.object({ outcome: z.literal("conflict") }),
    ]),
    kind: "write",
    secret: ["content"],
    internal: true,
  }),
});

export const projects = contract("projects", {
  list: op({ input: none, output: z.array(z.custom<Domain.Project>()) }),
});

export const machines = contract("machines", {
  list: op({ input: none, output: z.array(z.custom<Domain.Host>()) }),
  access: service<MachineAccessProvider>(),
});

export const users = contract("users", {
  current: op({ input: none, output: z.custom<Domain.User>().nullable() }),
  list: op({ input: none, output: z.array(z.custom<Domain.User>()) }),
});

export const sections = contract("sections", {
  list: op({
    input: none,
    output: z.array(z.custom<Contract.ThreadSectionResponse>()),
  }),
  create: op({
    input: z.object({ name: z.string() }),
    output: z.custom<Contract.ThreadSectionResponse>(),
    kind: "write",
  }),
});

export const plugins = contract("plugins", {
  inspect: op({ input: none, output: z.custom<KernelInspection>() }),
  describe: op({
    input: z.object({ id: z.string() }),
    output: z
      .object({
        id: z.string(),
        directory: z.string(),
        builtin: z.boolean(),
        original: z.string().nullable(),
      })
      .nullable(),
  }),
  install: op({
    input: z.object({ path: z.string(), watch: z.boolean().default(false) }),
    output: z.object({ id: z.string().nullable(), path: z.string() }),
    kind: "write",
    allow: "owner",
  }),
  uninstall: op({
    input: z.object({ path: z.string() }),
    output: nothing,
    kind: "write",
    allow: "owner",
  }),
  reload: op({
    input: z.object({ id: z.string().optional() }),
    output: nothing,
    kind: "write",
    allow: "owner",
  }),
});

export const server = contract("server", {
  publicUrl: service<() => string | null>(),
});

export const environments = contract("environments", {
  kind: slot<EnvironmentDefinition>({ key: "id" }),
});

export const pluginEventDefs = {
  "thread.created": threads.created,
  "thread.active": threads.active,
  "thread.idle": threads.idle,
  "thread.failed": threads.failed,
  "thread.archived": threads.archived,
  "thread.unarchived": threads.unarchived,
  "thread.deleted": threads.deleted,
  "interaction.pending": interactions.pending,
} as const;
