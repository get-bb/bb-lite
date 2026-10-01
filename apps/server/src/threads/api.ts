import type {
  JsonValue,
  PendingInteraction,
  PendingInteractionResolution,
  ThreadListEntry,
  ThreadQueuedMessage,
} from "@bb/domain";
import type {
  CreateQueuedMessageRequest,
  CreateThreadRequest,
  ReorderPinnedThreadRequest,
  ReorderQueuedMessageRequest,
  SendMessageRequest,
  SendMessageResponse,
  SendQueuedMessageMode,
  SetQueuedMessageGroupBoundaryRequest,
  ThreadResponse,
  UpdateQueuedMessageRequest,
  UpdateThreadRequest,
} from "@bb/server-contract";
import type { PluginInputRequest, PluginInputResult } from "./interactions.js";

export type { PluginInputRequest, PluginInputResult };

export interface ThreadEngine {
  start(): void;
  close(): Promise<void>;
  settled(): Promise<void>;
  sweep(): void;

  create(request: CreateThreadRequest): Promise<ThreadResponse>;
  send(
    threadId: string,
    request: SendMessageRequest,
  ): Promise<SendMessageResponse>;
  stop(threadId: string): Promise<void>;
  compact(threadId: string): Promise<void>;
  clearContext(threadId: string): Promise<void>;
  archive(threadId: string): Promise<string[]>;
  unarchive(threadId: string): Promise<void>;
  delete(
    threadId: string,
    options: { childThreadsConfirmed: boolean },
  ): Promise<void>;
  update(threadId: string, patch: UpdateThreadRequest): Promise<ThreadResponse>;
  pin(threadId: string): Promise<ThreadResponse>;
  unpin(threadId: string): Promise<ThreadResponse>;
  reorderPinned(
    threadId: string,
    request: ReorderPinnedThreadRequest,
  ): Promise<ThreadListEntry[]>;
  markRead(threadId: string): Promise<ThreadResponse>;
  markUnread(threadId: string): Promise<ThreadResponse>;

  createQueuedMessage(
    threadId: string,
    request: CreateQueuedMessageRequest,
  ): Promise<ThreadQueuedMessage>;
  updateQueuedMessage(
    threadId: string,
    queuedMessageId: string,
    request: UpdateQueuedMessageRequest,
  ): Promise<ThreadQueuedMessage>;
  deleteQueuedMessage(threadId: string, queuedMessageId: string): Promise<void>;
  reorderQueuedMessage(
    threadId: string,
    queuedMessageId: string,
    request: ReorderQueuedMessageRequest,
  ): Promise<ThreadQueuedMessage[]>;
  setQueuedMessageGroupBoundary(
    threadId: string,
    request: SetQueuedMessageGroupBoundaryRequest,
  ): Promise<ThreadQueuedMessage[]>;
  sendQueuedMessageNow(
    threadId: string,
    queuedMessageId: string,
    mode: SendQueuedMessageMode,
  ): Promise<SendMessageResponse>;

  resolveInteraction(
    threadId: string,
    interactionId: string,
    resolution: PendingInteractionResolution,
  ): Promise<PendingInteraction>;
  respondToInteraction(
    threadId: string,
    interactionId: string,
    value: JsonValue,
  ): Promise<PendingInteraction>;
  cancelInteraction(
    threadId: string,
    interactionId: string,
  ): Promise<PendingInteraction>;
  requestInput(request: PluginInputRequest): Promise<PluginInputResult>;
}
