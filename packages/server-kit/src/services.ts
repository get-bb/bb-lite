import type * as domain from "@bb/domain";
import type * as plugin from "@bb/plugin";
import type * as contract from "@bb/server-contract";
import type { DeletedProject } from "./db/projects.js";
import type {
  EnsureEnvironmentArgs,
  ThreadEnvironment,
} from "./environments/types.js";

export interface SessionEnvironment {
  id: string;
  hostId: string;
  path: string;
}

type Thread = contract.ThreadResponse;
type Queued = domain.ThreadQueuedMessage;
type Interaction = domain.PendingInteraction;

export interface ThreadEngine {
  start(): void;
  close(): Promise<void>;
  settled(): Promise<void>;
  sweep(): void;
  create(request: contract.CreateThreadRequest): Promise<Thread>;
  get(threadId: string): Thread | null;
  workspaceOf(threadId: string): SessionEnvironment;
  send(
    threadId: string,
    request: contract.SendMessageRequest,
  ): Promise<contract.SendMessageResponse>;
  stop(threadId: string): Promise<void>;
  compact(threadId: string): Promise<void>;
  clearContext(threadId: string): Promise<void>;
  archive(threadId: string): Promise<string[]>;
  unarchive(threadId: string): Promise<void>;
  delete(
    threadId: string,
    confirmation: { childThreadsConfirmed: boolean },
  ): Promise<void>;
  releaseDeletedProject(project: DeletedProject): void;
  update(
    threadId: string,
    patch: contract.UpdateThreadRequest,
  ): Promise<Thread>;
  pin(threadId: string): Promise<Thread>;
  unpin(threadId: string): Promise<Thread>;
  reorderPinned(
    threadId: string,
    request: contract.ReorderPinnedThreadRequest,
  ): domain.ThreadListEntry[];
  markRead(threadId: string): Promise<Thread>;
  markUnread(threadId: string): Promise<Thread>;
  createQueuedMessage(
    threadId: string,
    request: contract.CreateQueuedMessageRequest,
  ): Promise<Queued>;
  updateQueuedMessage(
    threadId: string,
    queuedMessageId: string,
    request: contract.UpdateQueuedMessageRequest,
  ): Promise<Queued>;
  deleteQueuedMessage(threadId: string, queuedMessageId: string): Promise<void>;
  sendQueuedMessageNow(
    threadId: string,
    queuedMessageId: string,
    mode: contract.SendQueuedMessageMode,
  ): Promise<contract.SendMessageResponse>;
  resolveInteraction(
    threadId: string,
    interactionId: string,
    resolution: domain.PendingInteractionResolution,
  ): Promise<Interaction>;
  respondToInteraction(
    threadId: string,
    interactionId: string,
    value: domain.JsonValue,
  ): Promise<Interaction>;
  cancelInteraction(threadId: string, id: string): Promise<Interaction>;
  requestInput(request: plugin.InputRequest): Promise<plugin.InputResult>;
}

export interface Environments {
  ensureForThread(job: EnsureEnvironmentArgs): Promise<ThreadEnvironment>;
  pathFor(id: string): string | null;
  workspaceInstructions(environmentId: string): Promise<string | null>;
  onThreadDetached(threadId: string): void;
  remove(environmentId: string): Promise<void>;
  sweep(): Promise<void>;
  start(): () => void;
}

export interface Terminals {
  closeFor(
    owner: "thread_id" | "environment_id",
    ownerId: string,
    reason: domain.TerminalSessionCloseReason,
  ): void;
}

type ToolContext = plugin.ThreadContext & { signal: AbortSignal };

export interface PluginQueries {
  titleFallback: plugin.TitleFallback | null;
  instructionsFor(context: plugin.ThreadContext): Promise<string>;
  toolsFor(context: plugin.ThreadContext): domain.DynamicTool[];
  callTool(
    name: string,
    input: unknown,
    context: ToolContext,
  ): Promise<domain.ToolCallResponse>;
  contributedEnv(
    providerId: string,
    context: plugin.ThreadContext,
  ): Promise<plugin.ProviderEnvEntry[]>;
  emit<Name extends keyof plugin.PluginEvents>(
    name: Name,
    payload: plugin.PluginEvents[Name],
  ): void;
  searchMentions(
    query: plugin.MentionQuery,
  ): Promise<contract.PluginMentionGroup[]>;
  resolveMention(pluginId: string, itemId: string): Promise<string>;
  generateTitle(prompt: string, signal: AbortSignal): Promise<string | null>;
  publicUrl(): string | null;
  machineAccess(): plugin.MachineAccessProvider | null;
  skillDirs(): string[];
}
