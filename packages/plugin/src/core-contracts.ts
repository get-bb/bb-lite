import * as Domain from "@bb/domain";
import * as Contract from "@bb/server-contract";
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
  ThreadFailure,
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

function at<Schema extends z.ZodType, const Param extends string>(
  schema: Schema,
  ...params: Param[]
): z.ZodType<
  z.output<Schema> & Record<Param, string>,
  z.input<Schema> & Record<Param, string>
> {
  const shape = Object.fromEntries(params.map((name) => [name, z.string()]));
  const combined =
    schema instanceof z.ZodObject
      ? schema.safeExtend(shape)
      : z.intersection(z.object(shape), schema);
  return combined as never;
}
const none = z.object({});

function ref<const Param extends string>(
  ...params: Param[]
): z.ZodType<Record<Param, string>> {
  const shape = Object.fromEntries(params.map((name) => [name, z.string()]));
  return z.object(shape) as never;
}
type Thread = Contract.ThreadResponse;
const threadEvent = <Extra = object>() =>
  event(z.custom<{ thread: Thread } & Extra>());

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
  executionOptions: op({
    input: Contract.systemExecutionOptionsQuerySchema,
    output: z.custom<Contract.SystemExecutionOptionsResponse>(),
    doors: { http: { method: "GET", path: "/system/execution-options" } },
  }),
  providers: op({
    input: Contract.systemProvidersQuerySchema,
    output: z.custom<Domain.ProviderInfo[]>(),
    doors: { http: { method: "GET", path: "/system/providers" } },
  }),
  providerCatalog: op({
    input: none,
    output: z.custom<Contract.SystemProviderCatalogEntry[]>(),
    doors: { http: { method: "GET", path: "/system/providers/catalog" } },
  }),
  updateProvider: op({
    input: at(Contract.systemProviderEnabledRequestSchema, "providerId"),
    output: z.custom<Contract.SystemProviderCatalogEntry[]>(),
    kind: "write",
    doors: {
      http: { method: "PUT", path: "/system/providers/:providerId/enabled" },
    },
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
  waitSettled: op({ input: none, output: nothing, internal: true }),
  sweep: op({ input: none, output: nothing, kind: "write", internal: true }),
  retired: event(
    threadRef.extend({
      reason: z.enum(["thread-deleted", "thread-archived"]),
    }),
  ),
  appended: event(
    z.object({ threadId: z.string(), types: z.array(z.string()) }),
  ),
  messageQueued: event(queuedRef),
  messageDispatched: event(queuedRef),
  messageDeleted: event(queuedRef),
  created: threadEvent(),
  active: threadEvent(),
  idle: threadEvent<{ lastAssistantText: string | null }>(),
  failed: threadEvent<{
    error: string | null;
    failure: ThreadFailure | null;
  }>(),
  archived: threadEvent(),
  unarchived: threadEvent(),
  deleted: threadEvent(),
  list: op({
    input: Contract.threadListQuerySchema,
    output: z.custom<Contract.ThreadListResponse>(),
    doors: { http: { method: "GET", path: "/threads" } },
  }),
  search: op({
    input: Contract.threadSearchQuerySchema,
    output: z.custom<Contract.ThreadSearchResponse>(),
    doors: { http: { method: "GET", path: "/threads/search" } },
  }),
  resolveMentions: op({
    input: Contract.resolveThreadMentionsRequestSchema,
    output: z.custom<Contract.ResolveThreadMentionsResponse>(),
    doors: { http: { method: "POST", path: "/threads/resolve-mentions" } },
  }),
  create: op({
    input: Contract.createThreadRequestSchema,
    output: z.custom<Contract.ThreadResponse>(),
    kind: "write",
    hooks: "answer",
    doors: { http: { method: "POST", path: "/threads", status: 201 } },
  }),
  get: op({
    input: at(Contract.threadGetQuerySchema, "threadId"),
    output: z.custom<
      Contract.ThreadResponse | Contract.ThreadWithIncludesResponse
    >(),
    doors: { http: { method: "GET", path: "/threads/:threadId" } },
  }),
  update: op({
    input: at(Contract.updateThreadRequestSchema, "threadId"),
    output: z.custom<Contract.ThreadResponse>(),
    kind: "write",
    hooks: "answer",
    doors: { http: { method: "PATCH", path: "/threads/:threadId" } },
  }),
  delete: op({
    input: at(Contract.deleteThreadRequestSchema, "threadId"),
    output: nothing,
    kind: "write",
    hooks: "answer",
    doors: { http: { method: "DELETE", path: "/threads/:threadId" } },
  }),
  childSummary: op({
    input: ref("threadId"),
    output: z.custom<Contract.ThreadChildSummaryResponse>(),
    doors: {
      http: { method: "GET", path: "/threads/:threadId/child-summary" },
    },
  }),
  send: op({
    input: at(Contract.sendMessageRequestSchema, "threadId"),
    output: z.custom<Contract.SendMessageResponse>(),
    kind: "write",
    hooks: "answer",
    doors: { http: { method: "POST", path: "/threads/:threadId/send" } },
  }),
  listQueuedMessages: op({
    input: ref("threadId"),
    output: z.custom<Contract.ThreadQueuedMessageListResponse>(),
    doors: {
      http: { method: "GET", path: "/threads/:threadId/queued-messages" },
    },
  }),
  createQueuedMessage: op({
    input: at(Contract.createQueuedMessageRequestSchema, "threadId"),
    output: z.custom<Domain.ThreadQueuedMessage>(),
    kind: "write",
    hooks: "answer",
    doors: {
      http: {
        method: "POST",
        path: "/threads/:threadId/queued-messages",
        status: 201,
      },
    },
  }),
  updateQueuedMessage: op({
    input: at(
      Contract.updateQueuedMessageRequestSchema,
      "threadId",
      "queuedMessageId",
    ),
    output: z.custom<Domain.ThreadQueuedMessage>(),
    kind: "write",
    hooks: "answer",
    doors: {
      http: {
        method: "PATCH",
        path: "/threads/:threadId/queued-messages/:queuedMessageId",
      },
    },
  }),
  sendQueuedMessage: op({
    input: at(
      Contract.sendQueuedMessageRequestSchema,
      "threadId",
      "queuedMessageId",
    ),
    output: z.custom<Contract.SendQueuedMessageResponse>(),
    kind: "write",
    hooks: "answer",
    doors: {
      http: {
        method: "POST",
        path: "/threads/:threadId/queued-messages/:queuedMessageId/send",
      },
    },
  }),
  promptHistory: op({
    input: at(Contract.promptHistoryQuerySchema, "threadId"),
    output: z.custom<Contract.PromptHistoryResponse>(),
    doors: {
      http: { method: "GET", path: "/threads/:threadId/prompt-history" },
    },
  }),
  deleteQueuedMessage: op({
    input: ref("threadId", "queuedMessageId"),
    output: nothing,
    kind: "write",
    hooks: "answer",
    doors: {
      http: {
        method: "DELETE",
        path: "/threads/:threadId/queued-messages/:queuedMessageId",
      },
    },
  }),
  stop: op({
    input: ref("threadId"),
    output: nothing,
    kind: "write",
    doors: { http: { method: "POST", path: "/threads/:threadId/stop" } },
  }),
  compact: op({
    input: ref("threadId"),
    output: nothing,
    kind: "write",
    hooks: "answer",
    doors: { http: { method: "POST", path: "/threads/:threadId/compact" } },
  }),
  clearContext: op({
    input: ref("threadId"),
    output: nothing,
    kind: "write",
    hooks: "answer",
    doors: {
      http: { method: "POST", path: "/threads/:threadId/context/clear" },
    },
  }),
  open: op({
    input: at(Contract.threadOpenRequestSchema, "threadId"),
    output: z.custom<Contract.ThreadOpenResponse>(),
    kind: "write",
    audit: false,
    doors: { http: { method: "POST", path: "/threads/:threadId/open" } },
  }),
  tabs: op({
    input: ref("threadId"),
    output: z.custom<Contract.ThreadTabsWireResponse>(),
    doors: { http: { method: "GET", path: "/threads/:threadId/tabs" } },
  }),
  updateTabs: op({
    input: at(Contract.updateThreadTabsRequestSchema, "threadId"),
    output: z.custom<Contract.ThreadTabsWireResponse>(),
    kind: "write",
    audit: false,
    doors: { http: { method: "PUT", path: "/threads/:threadId/tabs" } },
  }),
  pin: op({
    input: ref("threadId"),
    output: z.custom<Contract.ThreadResponse>(),
    kind: "write",
    audit: false,
    doors: { http: { method: "POST", path: "/threads/:threadId/pin" } },
  }),
  unpin: op({
    input: ref("threadId"),
    output: z.custom<Contract.ThreadResponse>(),
    kind: "write",
    audit: false,
    doors: { http: { method: "POST", path: "/threads/:threadId/unpin" } },
  }),
  reorderPinned: op({
    input: at(Contract.reorderPinnedThreadRequestSchema, "threadId"),
    output: z.custom<Contract.ThreadListResponse>(),
    kind: "write",
    audit: false,
    doors: { http: { method: "PATCH", path: "/threads/:threadId/pin-order" } },
  }),
  archive: op({
    input: ref("threadId"),
    output: z.custom<Contract.ThreadArchiveAllResponse>(),
    kind: "write",
    doors: { http: { method: "POST", path: "/threads/:threadId/archive-all" } },
  }),
  unarchive: op({
    input: ref("threadId"),
    output: nothing,
    kind: "write",
    doors: { http: { method: "POST", path: "/threads/:threadId/unarchive" } },
  }),
  markRead: op({
    input: ref("threadId"),
    output: z.custom<Contract.ThreadResponse>(),
    kind: "write",
    audit: false,
    doors: { http: { method: "POST", path: "/threads/:threadId/read" } },
  }),
  markUnread: op({
    input: ref("threadId"),
    output: z.custom<Contract.ThreadResponse>(),
    kind: "write",
    audit: false,
    doors: { http: { method: "POST", path: "/threads/:threadId/unread" } },
  }),
  timeline: op({
    input: at(Contract.threadTimelineQuerySchema, "threadId"),
    output: z.custom<Contract.ThreadTimelineResponse>(),
    doors: { http: { method: "GET", path: "/threads/:threadId/timeline" } },
  }),
  timelineTurnSummaryDetails: op({
    input: at(Contract.timelineTurnSummaryDetailsQuerySchema, "threadId"),
    output: z.custom<Contract.TimelineTurnSummaryDetailsResponse>(),
    doors: {
      http: {
        method: "GET",
        path: "/threads/:threadId/timeline/turn-summary-details",
      },
    },
  }),
  output: op({
    input: ref("threadId"),
    output: z.custom<{ output: string | null }>(),
    doors: { http: { method: "GET", path: "/threads/:threadId/output" } },
  }),
  events: op({
    input: at(Contract.threadEventsQuerySchema, "threadId"),
    output: z.custom<Domain.ThreadEventRow[]>(),
    doors: { http: { method: "GET", path: "/threads/:threadId/events" } },
  }),
  nextEvent: op({
    input: at(Contract.threadEventWaitQuerySchema, "threadId"),
    output: z.custom<Domain.ThreadEventRow | null>(),
    doors: {
      http: {
        method: "GET",
        path: "/threads/:threadId/events/wait",
        empty: 204,
      },
    },
  }),
  defaultExecutionOptions: op({
    input: ref("threadId"),
    output: z.custom<Domain.ResolvedThreadExecutionOptions | null>(),
    doors: {
      http: {
        method: "GET",
        path: "/threads/:threadId/default-execution-options",
      },
    },
  }),
});

export const interactions = contract("interactions", {
  pending: threadEvent<{ interaction: Domain.PendingInteraction }>(),
  ask: op({
    input: z.custom<InputRequest>(),
    output: z.custom<InputResult>(),
    kind: "write",
    internal: true,
  }),
  list: op({
    input: ref("threadId"),
    output: z.custom<Contract.ThreadPendingInteractionsResponse>(),
    doors: { http: { method: "GET", path: "/threads/:threadId/interactions" } },
  }),
  get: op({
    input: ref("threadId", "interactionId"),
    output: z.custom<Domain.PendingInteraction>(),
    doors: {
      http: {
        method: "GET",
        path: "/threads/:threadId/interactions/:interactionId",
      },
    },
  }),
  resolve: op({
    input: at(
      z.object({ resolution: Contract.resolvePendingInteractionRequestSchema }),
      "threadId",
      "interactionId",
    ),
    output: z.custom<Domain.PendingInteraction>(),
    kind: "write",
    hooks: "answer",
    doors: {
      http: {
        method: "POST",
        path: "/threads/:threadId/interactions/:interactionId/resolve",
        body: "resolution",
      },
    },
  }),
  respond: op({
    input: at(
      Contract.respondPluginInteractionRequestSchema,
      "threadId",
      "interactionId",
    ),
    output: z.custom<Domain.PendingInteraction>(),
    kind: "write",
    hooks: "answer",
    doors: {
      http: {
        method: "POST",
        path: "/threads/:threadId/interactions/:interactionId/respond",
      },
    },
  }),
  cancel: op({
    input: ref("threadId", "interactionId"),
    output: z.custom<Domain.PendingInteraction>(),
    kind: "write",
    hooks: "answer",
    doors: {
      http: {
        method: "POST",
        path: "/threads/:threadId/interactions/:interactionId/cancel",
      },
    },
  }),
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
  delete: op({
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
  table: table<ProjectTableRow>(),
  deleted: event(z.custom<ProjectDeletion>()),
  machineEnvironment: op({
    input: ref("projectId"),
    output: z.custom<Contract.ProjectMachineEnvironmentList>(),
    doors: {
      http: { method: "GET", path: "/projects/:projectId/machine-environment" },
    },
  }),
  updateMachineEnvironment: op({
    input: at(Contract.machineEnvironmentReplaceSchema, "projectId"),
    output: z.custom<Contract.ProjectMachineEnvironmentList>(),
    kind: "write",
    doors: {
      http: { method: "PUT", path: "/projects/:projectId/machine-environment" },
    },
  }),
  list: op({
    input: Contract.projectListQuerySchema,
    output: z.custom<
      Contract.ProjectResponse[] | Contract.ProjectWithThreadsResponse[]
    >(),
    doors: { http: { method: "GET", path: "/projects" } },
  }),
  create: op({
    input: Contract.createProjectRequestSchema,
    output: z.custom<Contract.ProjectResponse>(),
    kind: "write",
    doors: { http: { method: "POST", path: "/projects", status: 201 } },
  }),
  sidebar: op({
    input: none,
    output: z.custom<Contract.SidebarBootstrapResponse>(),
    doors: { http: { method: "GET", path: "/sidebar-bootstrap" } },
  }),
  get: op({
    input: ref("projectId"),
    output: z.custom<Contract.ProjectResponse>(),
    doors: { http: { method: "GET", path: "/projects/:projectId" } },
  }),
  update: op({
    input: at(Contract.updateProjectRequestSchema, "projectId"),
    output: z.custom<Contract.ProjectResponse>(),
    kind: "write",
    doors: { http: { method: "PATCH", path: "/projects/:projectId" } },
  }),
  delete: op({
    input: ref("projectId"),
    output: nothing,
    kind: "write",
    doors: { http: { method: "DELETE", path: "/projects/:projectId" } },
  }),
  defaultExecutionOptions: op({
    input: ref("projectId"),
    output: z.custom<Domain.ProjectExecutionDefaults | null>(),
    doors: {
      http: {
        method: "GET",
        path: "/projects/:projectId/default-execution-options",
      },
    },
  }),
  promptHistory: op({
    input: at(Contract.promptHistoryQuerySchema, "projectId"),
    output: z.custom<Contract.PromptHistoryResponse>(),
    doors: {
      http: { method: "GET", path: "/projects/:projectId/prompt-history" },
    },
  }),
  createSource: op({
    input: at(
      z.object({ source: Contract.createProjectSourceRequestSchema }),
      "projectId",
    ),
    output: z.custom<Domain.ProjectSource>(),
    kind: "write",
    doors: {
      http: {
        method: "POST",
        path: "/projects/:projectId/sources",
        status: 201,
        body: "source",
      },
    },
  }),
  updateSource: op({
    input: at(
      Contract.updateProjectSourceRequestSchema,
      "projectId",
      "sourceId",
    ),
    output: z.custom<Domain.ProjectSource>(),
    kind: "write",
    doors: {
      http: { method: "PATCH", path: "/projects/:projectId/sources/:sourceId" },
    },
  }),
  deleteSource: op({
    input: ref("projectId", "sourceId"),
    output: nothing,
    kind: "write",
    doors: {
      http: {
        method: "DELETE",
        path: "/projects/:projectId/sources/:sourceId",
      },
    },
  }),
  paths: op({
    input: at(Contract.projectPathsQuerySchema, "projectId"),
    output: z.custom<Contract.WorkspacePathListResponse>(),
    doors: { http: { method: "GET", path: "/projects/:projectId/paths" } },
  }),
  commands: op({
    input: at(Contract.projectCommandsQuerySchema, "projectId"),
    output: z.custom<Contract.CommandListResponse>(),
    doors: { http: { method: "GET", path: "/projects/:projectId/commands" } },
  }),
  branches: op({
    input: at(Contract.projectBranchesQuerySchema, "projectId"),
    output: z.custom<Contract.ProjectBranchesResponse>(),
    doors: { http: { method: "GET", path: "/projects/:projectId/branches" } },
  }),
  branchOptions: op({
    input: at(Contract.projectBranchesQuerySchema, "projectId"),
    output: z.custom<Contract.ProjectBranchesResponse>(),
    doors: {
      http: { method: "GET", path: "/projects/:projectId/branch-options" },
    },
  }),
  copyAttachments: op({
    input: at(Contract.copyProjectAttachmentsRequestSchema, "projectId"),
    output: nothing,
    kind: "write",
    doors: {
      http: { method: "POST", path: "/projects/:projectId/attachments/copy" },
    },
  }),
});

export interface MachineRef {
  hostId: string;
  resource: Domain.JsonValue | null;
}

export interface MachineProvider {
  id: string;
  displayName: string;
  delete?(machine: MachineRef): void | Promise<void>;
  suspend?(machine: MachineRef): void | Promise<void>;
  resume?(machine: MachineRef): void | Promise<void>;
}

const machineRef = z.object({ hostId: z.string() });
const MACHINE_WAIT_MAX_MS = 600_000;

export const machines = contract("machines", {
  access: service<MachineAccessProvider>(),
  guard: service<(hostId: string) => void>(),
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
  connected: event(machineRef),
  disconnected: event(machineRef),
  deleted: event(machineRef),
  signaled: event(
    machineRef.extend({
      pluginId: z.string(),
      name: z.string(),
      payload: z.unknown(),
    }),
  ),
  readFile: op({
    input: Contract.hostFileReadRequestSchema,
    output: z.custom<Contract.HostFileReadResponse>(),
    doors: { http: { method: "POST", path: "/files/read" } },
  }),
  writeFile: op({
    input: Contract.hostFileWriteRequestSchema,
    output: z.custom<Contract.HostFileWriteResponse>(),
    kind: "write",
    doors: { http: { method: "POST", path: "/files/write" } },
  }),
  listFiles: op({
    input: Contract.hostFileListRequestSchema,
    output: z.custom<Contract.HostFileListResponse>(),
    doors: { http: { method: "POST", path: "/files/list" } },
  }),
  create: op({
    input: Contract.createMachineRequestSchema,
    output: z.custom<Domain.Host>(),
    kind: "write",
    doors: { http: { method: "POST", path: "/hosts", status: 201 } },
  }),
  list: op({
    input: Contract.hostListQuerySchema,
    output: z.custom<Domain.Host[]>(),
    doors: { http: { method: "GET", path: "/hosts" } },
  }),
  get: op({
    input: ref("hostId"),
    output: z.custom<
      Domain.Host & {
        connectMachineId: string | null;
        threadStorageRootPath: string | null;
      }
    >(),
    doors: { http: { method: "GET", path: "/hosts/:hostId" } },
  }),
  enrollmentCommand: op({
    input: ref("hostId"),
    output: z.custom<Contract.HostEnrollmentCommandResponse>(),
    doors: {
      http: { method: "GET", path: "/hosts/:hostId/enrollment-command" },
    },
  }),
  createReconnectCommand: op({
    input: ref("hostId"),
    output: z.custom<Contract.HostReconnectResponse>(),
    kind: "write",
    doors: {
      http: {
        method: "POST",
        path: "/hosts/:hostId/reconnect-commands",
        status: 201,
      },
    },
  }),
  update: op({
    input: machineRef.extend({
      name: z.string().trim().min(1).max(100).optional(),
      resource: Domain.jsonValueSchema.optional(),
    }),
    output: z.custom<Domain.Host>(),
    kind: "write",
    doors: { http: { method: "PATCH", path: "/hosts/:hostId" } },
  }),
  updateSharing: op({
    input: at(Contract.updateHostSharingRequestSchema, "hostId"),
    output: z.custom<Domain.Host>(),
    kind: "write",
    doors: { http: { method: "PATCH", path: "/hosts/:hostId/sharing" } },
  }),
  updatePermissionCeiling: op({
    input: at(Contract.updateHostPermissionCeilingRequestSchema, "hostId"),
    output: z.custom<Domain.Host>(),
    kind: "write",
    doors: {
      http: { method: "PATCH", path: "/hosts/:hostId/permission-ceiling" },
    },
  }),
  delete: op({
    input: ref("hostId"),
    output: nothing,
    kind: "write",
    doors: { http: { method: "DELETE", path: "/hosts/:hostId" } },
  }),
  directory: op({
    input: at(Contract.hostDirectoryQuerySchema, "hostId"),
    output: z.custom<Contract.HostDirectoryListing>(),
    doors: { http: { method: "GET", path: "/hosts/:hostId/directory" } },
  }),
  pathsExist: op({
    input: at(Contract.hostPathsExistRequestSchema, "hostId"),
    output: z.custom<Contract.HostPathsExistResponse>(),
    doors: { http: { method: "POST", path: "/hosts/:hostId/paths/exist" } },
  }),
  openTargets: op({
    input: ref("hostId"),
    output: z.custom<Contract.HostOpenTargetsResponse>(),
    doors: { http: { method: "GET", path: "/hosts/:hostId/open-targets" } },
  }),
  open: op({
    input: at(Contract.hostOpenRequestSchema, "hostId"),
    output: nothing,
    kind: "write",
    audit: false,
    doors: { http: { method: "POST", path: "/hosts/:hostId/open" } },
  }),
});

export const users = contract("users", {
  current: op({ input: none, output: z.custom<Domain.User>().nullable() }),
  list: op({
    input: none,
    output: z.custom<Domain.User[]>(),
    doors: { http: { method: "GET", path: "/users" } },
  }),
  update: op({
    input: at(Contract.updateUserRequestSchema, "userId"),
    output: z.custom<Domain.User>(),
    kind: "write",
    doors: { http: { method: "PATCH", path: "/users/:userId" } },
  }),
  setPassword: op({
    input: at(Contract.setPasswordRequestSchema, "userId"),
    output: z.custom<Domain.User>(),
    kind: "write",
    doors: { http: { method: "PUT", path: "/users/:userId/password" } },
  }),
  createSignInLink: op({
    input: ref("userId"),
    output: z.custom<Contract.SignInLinkResponse>(),
    kind: "write",
    doors: {
      http: {
        method: "POST",
        path: "/users/:userId/sign-in-links",
        status: 201,
      },
    },
  }),
  listInvites: op({
    input: none,
    output: z.custom<Contract.UserInvite[]>(),
    doors: { http: { method: "GET", path: "/user-invites" } },
  }),
  createInvite: op({
    input: Contract.createInviteRequestSchema,
    output: z.custom<Contract.CreatedInviteResponse>(),
    kind: "write",
    doors: { http: { method: "POST", path: "/user-invites", status: 201 } },
  }),
  deleteInvite: op({
    input: ref("inviteId"),
    output: nothing,
    kind: "write",
    doors: { http: { method: "DELETE", path: "/user-invites/:inviteId" } },
  }),
  presence: op({
    input: none,
    output: z.custom<Contract.PresenceResponse>(),
    doors: { http: { method: "GET", path: "/presence" } },
  }),
});

export const sections = contract("sections", {
  list: op({
    input: none,
    output: z.custom<Contract.ThreadSectionResponse[]>(),
    doors: { http: { method: "GET", path: "/thread-sections" } },
  }),
  create: op({
    input: Contract.createThreadSectionRequestSchema,
    output: z.custom<Contract.ThreadSectionResponse>(),
    kind: "write",
    doors: { http: { method: "POST", path: "/thread-sections", status: 201 } },
  }),
  update: op({
    input: Contract.updateThreadSectionRequestSchema,
    output: z.custom<Contract.ThreadSectionMutationResponse>(),
    kind: "write",
    doors: { http: { method: "PATCH", path: "/thread-sections" } },
  }),
  delete: op({
    input: Contract.deleteThreadSectionRequestSchema,
    output: z.custom<Contract.ThreadSectionMutationResponse>(),
    kind: "write",
    doors: { http: { method: "DELETE", path: "/thread-sections" } },
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
  list: op({
    input: none,
    output: z.custom<Contract.PluginListResponse>(),
    doors: { http: { method: "GET", path: "/plugins" } },
  }),
  contributions: op({
    input: none,
    output: z.custom<Contract.PluginContributionsResponse>(),
    doors: { http: { method: "GET", path: "/plugins/contributions" } },
  }),
  reload: op({
    input: z.object({ id: z.string().optional() }),
    output: z.custom<Contract.PluginListResponse>(),
    kind: "write",
    allow: "owner",
    doors: { http: { method: "POST", path: "/plugins/reload" } },
  }),
  enable: op({
    input: ref("pluginId"),
    output: z.custom<{ ok: true; plugin: Contract.InstalledPlugin }>(),
    kind: "write",
    allow: "owner",
    doors: { http: { method: "POST", path: "/plugins/:pluginId/enable" } },
  }),
  disable: op({
    input: ref("pluginId"),
    output: z.custom<{ ok: true; plugin: Contract.InstalledPlugin }>(),
    kind: "write",
    allow: "owner",
    doors: { http: { method: "POST", path: "/plugins/:pluginId/disable" } },
  }),
  settings: op({
    input: ref("pluginId"),
    output: z.custom<Contract.PluginSettingsResponse>(),
    doors: { http: { method: "GET", path: "/plugins/:pluginId/settings" } },
  }),
  updateSettings: op({
    input: at(Contract.pluginSettingsUpdateRequestSchema, "pluginId"),
    output: z.custom<Contract.PluginSettingsResponse>(),
    kind: "write",
    secret: ["values"],
    doors: { http: { method: "PUT", path: "/plugins/:pluginId/settings" } },
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
  inputReceived: event(
    z.object({
      terminalId: z.string(),
      hostId: z.string(),
      threadId: z.string().nullable(),
    }),
  ),
  list: op({
    input: Contract.terminalListQuerySchema,
    output: z.custom<Contract.TerminalListResponse>(),
    doors: { http: { method: "GET", path: "/terminals" } },
  }),
  create: op({
    input: Contract.createTerminalRequestSchema,
    output: z.custom<Contract.TerminalSession>(),
    kind: "write",
    doors: { http: { method: "POST", path: "/terminals", status: 201 } },
  }),
  get: op({
    input: ref("terminalId"),
    output: z.custom<Contract.TerminalSession>(),
    doors: { http: { method: "GET", path: "/terminals/:terminalId" } },
  }),
  update: op({
    input: at(Contract.updateTerminalRequestSchema, "terminalId"),
    output: z.custom<Contract.TerminalSession>(),
    kind: "write",
    doors: { http: { method: "PATCH", path: "/terminals/:terminalId" } },
  }),
  close: op({
    input: at(Contract.closeTerminalRequestSchema, "terminalId"),
    output: z.custom<Contract.TerminalSession>(),
    kind: "write",
    doors: { http: { method: "POST", path: "/terminals/:terminalId/close" } },
  }),
  write: op({
    input: at(Contract.terminalInputRequestSchema, "terminalId"),
    output: z.custom<Contract.TerminalSession>(),
    kind: "write",
    audit: false,
    doors: { http: { method: "POST", path: "/terminals/:terminalId/input" } },
  }),
  output: op({
    input: at(Contract.terminalOutputQuerySchema, "terminalId"),
    output: z.custom<Contract.TerminalOutputResponse>(),
    doors: { http: { method: "GET", path: "/terminals/:terminalId/output" } },
  }),
});

export const appearance = contract("appearance", {
  theme: slot<Domain.PluginTheme>({ key: "id" }),
});

export const server = contract("server", {
  publicUrl: service<() => string | null>(),
  authenticator: service<Authenticator>(),
  config: op({
    input: none,
    output: z.custom<Contract.SystemConfigResponse>(),
    doors: { http: { method: "GET", path: "/system/config" } },
  }),
});

const environmentRef = z.object({ environmentId: z.string() });

export const environments = contract("environments", {
  kind: slot<EnvironmentDefinition>({ key: "id" }),
  instructions: op({
    input: environmentRef,
    output: z.string().nullable(),
    internal: true,
  }),
  sweep: op({ input: none, output: nothing, kind: "write", internal: true }),
  destroyed: event(
    environmentRef.extend({ reason: z.literal("environment-destroyed") }),
  ),
  list: op({
    input: Contract.listEnvironmentsQuerySchema,
    output: z.custom<Domain.Environment[]>(),
    doors: { http: { method: "GET", path: "/environments" } },
  }),
  delete: op({
    input: ref("environmentId"),
    output: nothing,
    kind: "write",
    doors: { http: { method: "DELETE", path: "/environments/:environmentId" } },
  }),
  get: op({
    input: ref("environmentId"),
    output: z.custom<Domain.Environment>(),
    doors: { http: { method: "GET", path: "/environments/:environmentId" } },
  }),
  update: op({
    input: at(Contract.updateEnvironmentRequestSchema, "environmentId"),
    output: z.custom<Domain.Environment>(),
    kind: "write",
    doors: { http: { method: "PATCH", path: "/environments/:environmentId" } },
  }),
  status: op({
    input: at(Contract.environmentStatusQuerySchema, "environmentId"),
    output: z.custom<Contract.EnvironmentStatusResponse>(),
    doors: {
      http: { method: "GET", path: "/environments/:environmentId/status" },
    },
  }),
  diffFiles: op({
    input: at(Contract.environmentDiffQuerySchema, "environmentId"),
    output: z.custom<Contract.EnvironmentDiffFilesResponse>(),
    doors: {
      http: { method: "GET", path: "/environments/:environmentId/diff/files" },
    },
  }),
  diffPatch: op({
    input: at(Contract.environmentDiffPatchRequestSchema, "environmentId"),
    output: z.custom<Contract.EnvironmentDiffPatchResponse>(),
    doors: {
      http: { method: "POST", path: "/environments/:environmentId/diff/patch" },
    },
  }),
  diffFile: op({
    input: at(Contract.environmentDiffFileQuerySchema, "environmentId"),
    output: z.custom<Contract.EnvironmentDiffFileResponse>(),
    doors: {
      http: { method: "GET", path: "/environments/:environmentId/diff/file" },
    },
  }),
  diffBranches: op({
    input: at(Contract.environmentDiffBranchesQuerySchema, "environmentId"),
    output: z.custom<Contract.EnvironmentDiffBranchesResponse>(),
    doors: {
      http: {
        method: "GET",
        path: "/environments/:environmentId/diff/branches",
      },
    },
  }),
  paths: op({
    input: at(Contract.environmentPathsQuerySchema, "environmentId"),
    output: z.custom<Contract.WorkspacePathListResponse>(),
    doors: {
      http: { method: "GET", path: "/environments/:environmentId/paths" },
    },
  }),
  runAction: op({
    input: environmentRef.extend({ action: z.literal("commit") }),
    output: z.custom<Contract.EnvironmentActionResponse>(),
    kind: "write",
    doors: {
      http: { method: "POST", path: "/environments/:environmentId/actions" },
    },
  }),
  archiveThreads: op({
    input: ref("environmentId"),
    output: z.custom<Contract.EnvironmentArchiveThreadsResponse>(),
    kind: "write",
    doors: {
      http: {
        method: "POST",
        path: "/environments/:environmentId/archive-threads",
      },
    },
  }),
  providers: op({
    input: Contract.systemEnvironmentProvidersQuerySchema,
    output: z.custom<Contract.SystemEnvironmentProvidersResponse>(),
    doors: { http: { method: "GET", path: "/system/environment-providers" } },
  }),
});

export const settings = contract("settings", {
  machineEnvironment: op({
    input: none,
    output: z.custom<Contract.MachineEnvironmentList>(),
    doors: { http: { method: "GET", path: "/settings/machine-environment" } },
  }),
  updateMachineEnvironment: op({
    input: Contract.machineEnvironmentReplaceSchema,
    output: z.custom<Contract.MachineEnvironmentList>(),
    kind: "write",
    doors: { http: { method: "PUT", path: "/settings/machine-environment" } },
  }),
  updateGeneral: op({
    input: z.object({ settings: Domain.appSettingsUpdateSchema }),
    output: z.custom<Domain.AppSettings>(),
    kind: "write",
    doors: {
      http: { method: "PUT", path: "/settings/general", body: "settings" },
    },
  }),
  updateKeyboard: op({
    input: z.object({ overrides: Domain.appKeybindingOverridesSchema }),
    output: z.custom<Domain.AppKeybindingOverrides>(),
    kind: "write",
    doors: {
      http: { method: "PUT", path: "/settings/keyboard", body: "overrides" },
    },
  }),
  updateAppearance: op({
    input: Domain.appThemeSchema,
    output: z.custom<Domain.AppTheme>(),
    kind: "write",
    doors: { http: { method: "PUT", path: "/settings/appearance" } },
  }),
  uiPreferences: op({
    input: none,
    output: z.custom<Contract.UiPreferencesResponse>(),
    doors: { http: { method: "GET", path: "/preferences/ui" } },
  }),
  updateUiPreference: op({
    input: at(Contract.updateUiPreferenceRequestSchema, "key"),
    output: z.custom<Contract.UiPreferenceResponse>(),
    kind: "write",
    audit: false,
    doors: { http: { method: "PUT", path: "/preferences/ui/:key" } },
  }),
  resetUiPreference: op({
    input: ref("key"),
    output: z.custom<Contract.UiPreferenceResponse>(),
    kind: "write",
    audit: false,
    doors: { http: { method: "DELETE", path: "/preferences/ui/:key" } },
  }),
});
