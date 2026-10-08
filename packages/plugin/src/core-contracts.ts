import * as Domain from "@bb/domain";
import type * as Contract from "@bb/server-contract";
import { z } from "zod";
import { contract, event, op, service, slot, table } from "./contract.js";
import type { KernelInspection } from "./kernel.js";
import type {
  Authenticator,
  EnvironmentDefinition,
  FileReadArgs,
  FileWriteArgs,
  InferenceService,
  InputRequest,
  InputResult,
  MachineAccessProvider,
  MentionProvider,
  MentionQuery,
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
  permissionModes?: Domain.ProviderInfo["capabilities"]["permissionModes"];
  modelCatalogScope?: Domain.ProviderInfo["capabilities"]["modelCatalogScope"];
  settings?: Record<string, ProviderToggle>;
}

export interface UsageSource {
  providerId: string;
  read(options: { hostId: string | null }): Promise<Domain.JsonValue>;
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
const queuedRef = z.object({
  threadId: z.string(),
  queuedMessageId: z.string(),
});
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
  tools: op({
    input: threadContextSchema,
    output: z.array(z.custom<Domain.DynamicTool>()),
    internal: true,
  }),
  skillDirs: op({
    input: threadContextSchema,
    output: z.array(z.string()),
  }),
  mention: slot<MentionProvider>(),
  inference: slot<InferenceService>(),
  provider: slot<ProviderDeclaration>({ key: "id" }),
  usage: slot<UsageSource>({ key: "providerId" }),
  providers: op({
    input: none,
    output: z.array(z.custom<Domain.ProviderInfo>()),
  }),
  executionOptions: op({
    input: z.custom<Contract.SystemExecutionOptionsQuery>(),
    output: z.custom<Contract.SystemExecutionOptionsResponse>(),
  }),
  titleFallback: service<TitleFallback>(),
  searchMentions: op({
    input: z.custom<MentionQuery>(),
    output: z.array(z.custom<Contract.PluginMentionGroup>()),
    internal: true,
  }),
  resolveMention: op({
    input: z.object({ pluginId: z.string(), itemId: z.string() }),
    output: z.string(),
    internal: true,
  }),
  title: op({
    input: z.object({ prompt: z.string() }),
    output: z.string().nullable(),
    internal: true,
  }),
});

export interface ThreadTableRow {
  id: string;
  projectId: string;
  environmentId: string | null;
  providerId: string;
  title: string | null;
  status: string;
  parentThreadId: string | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export const threads = contract("threads", {
  table: table<ThreadTableRow>(),
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
  hold: op({
    input: threadRef.extend({
      projectId: z.string(),
      providerId: z.string(),
      sendNow: z.boolean(),
    }),
    output: z
      .object({
        pluginId: z.string().min(1),
        reason: z.string().min(1).max(200),
      })
      .nullable(),
    hooks: "answer",
    internal: true,
  }),
  release: op({
    input: threadRef,
    output: nothing,
    kind: "write",
    internal: true,
  }),
  storageLocation: op({
    input: threadRef,
    output: z.object({ hostId: z.string(), path: z.string() }).nullable(),
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
  workspace: op({
    input: threadRef,
    output: z.object({ id: z.string(), hostId: z.string(), path: z.string() }),
    internal: true,
  }),
  requestInput: op({
    input: z.custom<
      Omit<InputRequest, "presentation" | "timeoutMs"> & {
        pluginId: string;
        presentation?: Domain.ThreadEventItemPresentation;
      }
    >(),
    output: z.custom<InputResult>(),
    kind: "write",
    internal: true,
  }),
  settled: op({ input: none, output: nothing, internal: true }),
  sweep: op({ input: none, output: nothing, kind: "write", internal: true }),
  released: event(
    threadRef.extend({
      reason: z.enum(["thread-deleted", "thread-archived"]),
    }),
  ),
  update: threadWrite(),
  compact: threadWrite(),
  clearContext: threadWrite(),
  queueMessage: threadWrite(),
  editQueuedMessage: threadWrite(),
  dropQueuedMessage: threadWrite(),
  sendQueuedMessage: threadWrite(),
  appended: event(
    z.object({ threadId: z.string(), types: z.array(z.string()) }),
  ),
  messageQueued: event(queuedRef),
  messageDispatched: event(queuedRef),
  messageCancelled: event(queuedRef),
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
  list: op({
    input: z.object({
      threadId: z.string(),
      path: z.string().optional(),
      query: z.string().optional(),
      limit: z.number().int().positive().max(5_000).default(1_000),
      directories: z.boolean().default(false),
    }),
    output: z.object({
      paths: z.array(z.object({ path: z.string(), name: z.string() })),
      truncated: z.boolean(),
    }),
    internal: true,
  }),
  mkdir: op({
    input: z.object({ threadId: z.string(), path: z.string() }),
    output: nothing,
    kind: "write",
    internal: true,
  }),
  remove: op({
    input: z.object({
      threadId: z.string(),
      path: z.string(),
      recursive: z.boolean().default(false),
    }),
    output: nothing,
    kind: "write",
    internal: true,
  }),
  move: op({
    input: z.object({
      threadId: z.string(),
      from: z.string(),
      to: z.string(),
    }),
    output: nothing,
    kind: "write",
    internal: true,
  }),
});

export interface ProjectTableRow {
  id: string;
  name: string;
  kind: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectDeletion {
  projectId: string;
  threadIds: string[];
  environments: {
    id: string;
    hostId: string;
    path: string | null;
    providerOwnsPath: number;
  }[];
}

export const projects = contract("projects", {
  list: op({ input: none, output: z.array(z.custom<Domain.Project>()) }),
  table: table<ProjectTableRow>(),
  deleted: event(z.custom<ProjectDeletion>()),
});

export interface MachineRef {
  hostId: string;
  resource: Domain.JsonValue | null;
}

export interface MachineProvider {
  id: string;
  displayName: string;
  remove?(machine: MachineRef): void | Promise<void>;
  suspend?(machine: MachineRef): void | Promise<void>;
  resume?(machine: MachineRef): void | Promise<void>;
}

const machineRef = z.object({ hostId: z.string() });
const MACHINE_WAIT_MAX_MS = 600_000;

export const machines = contract("machines", {
  list: op({ input: none, output: z.array(z.custom<Domain.Host>()) }),
  access: service<MachineAccessProvider>(),
  usable: service<(hostId: string) => void>(),
  provider: slot<MachineProvider>({ key: "id" }),
  enroll: op({
    input: z.object({
      name: z.string().min(1),
      providerId: z.string().min(1).optional(),
      resource: Domain.jsonValueSchema.optional(),
    }),
    output: z.object({
      hostId: z.string(),
      command: z.string(),
      serverUrl: z.string(),
      expiresAt: z.number(),
    }),
    kind: "write",
    internal: true,
  }),
  waitConnected: op({
    input: machineRef.extend({
      timeoutMs: z
        .number()
        .int()
        .min(0)
        .max(MACHINE_WAIT_MAX_MS)
        .default(120_000),
    }),
    output: z.boolean(),
    hooks: "observe",
    internal: true,
  }),
  update: op({
    input: machineRef.extend({
      name: z.string().min(1).optional(),
      resource: Domain.jsonValueSchema.optional(),
    }),
    output: nothing,
    kind: "write",
    internal: true,
  }),
  suspend: op({
    input: machineRef,
    output: nothing,
    kind: "write",
    internal: true,
  }),
  resume: op({
    input: machineRef,
    output: nothing,
    kind: "write",
    internal: true,
  }),
  remove: op({
    input: machineRef,
    output: nothing,
    kind: "write",
    internal: true,
  }),
  connected: event(machineRef),
  disconnected: event(machineRef),
  removed: event(machineRef),
  signal: event(
    machineRef.extend({
      pluginId: z.string(),
      name: z.string(),
      payload: z.unknown(),
    }),
  ),
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
  agentInstructions: op({
    input: threadContextSchema,
    output: z.array(instructionSectionSchema),
    internal: true,
  }),
  agentTools: op({
    input: threadContextSchema,
    output: z.array(z.custom<Domain.DynamicTool>()),
    internal: true,
  }),
  callAgentTool: op({
    input: z.object({
      name: z.string(),
      input: z.unknown(),
      context: threadContextSchema,
    }),
    output: z.custom<Domain.ToolCallResponse>(),
    kind: "write",
    hooks: "observe",
    internal: true,
  }),
  skillDirs: op({ input: none, output: z.array(z.string()), internal: true }),
});

export const terminals = contract("terminals", {
  resize: op({
    input: z.object({
      terminalId: z.string(),
      cols: z.number().int().positive(),
      rows: z.number().int().positive(),
    }),
    output: nothing,
    kind: "write",
    internal: true,
  }),
  input: event(
    z.object({
      terminalId: z.string(),
      hostId: z.string(),
      threadId: z.string().nullable(),
    }),
  ),
});

export const appearance = contract("appearance", {
  theme: slot<Domain.PluginTheme>({ key: "id" }),
});

export const server = contract("server", {
  publicUrl: service<() => string | null>(),
  authenticator: service<Authenticator>(),
});

const environmentRef = z.object({ environmentId: z.string() });

export const environments = contract("environments", {
  kind: slot<EnvironmentDefinition>({ key: "id" }),
  instructions: op({
    input: environmentRef,
    output: z.string().nullable(),
    internal: true,
  }),
  remove: op({
    input: environmentRef,
    output: nothing,
    kind: "write",
    internal: true,
  }),
  sweep: op({ input: none, output: nothing, kind: "write", internal: true }),
  released: event(
    environmentRef.extend({ reason: z.literal("environment-destroyed") }),
  ),
  get: op({
    input: z.object({ environmentId: z.string() }),
    output: z.custom<Domain.Environment>().nullable(),
  }),
  list: op({
    input: z.object({
      projectId: z.string().optional(),
      hostId: z.string().optional(),
    }),
    output: z.array(z.custom<Domain.Environment>()),
  }),
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
