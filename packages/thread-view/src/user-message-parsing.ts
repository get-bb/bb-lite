import {
  requireThreadEventScopeTurnId,
  turnScope,
  type ClientTurnRequestId,
  type PromptInput,
  type PromptTextMention,
  type Thread,
  type ThreadEvent,
} from "@bb/domain";
import type {
  TimelineConversationAttachments,
  TimelineConversationTurnRequest,
} from "@bb/server-contract";
import type {
  EventMeta,
  ThreadEventWithMeta,
  UserMessage,
} from "./event-projection-types.js";
import { messageId, parseAgentMessageEnvelope } from "./timeline-format.js";

export type AcceptedClientRequest = { meta: EventMeta; turnId: string };

export type ClientTurnRequestedEvent = Extract<
  ThreadEvent,
  { type: "client/turn/requested" }
>;

export function buildAcceptedClientRequestById(
  events: readonly ThreadEventWithMeta[],
): Map<ClientTurnRequestId, AcceptedClientRequest> {
  const acceptedById = new Map<ClientTurnRequestId, AcceptedClientRequest>();
  for (const { event, meta } of events) {
    if (event.type !== "turn/input/accepted") continue;
    const turnId = requireThreadEventScopeTurnId(event);
    if (!acceptedById.has(event.clientRequestId)) {
      acceptedById.set(event.clientRequestId, { meta, turnId });
    }
  }
  return acceptedById;
}

export function parsePromptInput(input: readonly PromptInput[]): {
  text: string;
  mentions: PromptTextMention[];
  attachments: TimelineConversationAttachments;
} | null {
  let text = "";
  const mentions: PromptTextMention[] = [];
  const imageUrls: string[] = [];
  const localImagePaths: string[] = [];
  const localFilePaths: string[] = [];
  const counts = { webImages: 0, localImages: 0, localFiles: 0 };
  for (const part of input) {
    if (part.visibility === "agent-only") continue;
    switch (part.type) {
      case "text":
        for (const mention of part.mentions) {
          if (
            mention.start >= 0 &&
            mention.end > mention.start &&
            mention.end <= part.text.length
          ) {
            mentions.push({
              ...mention,
              start: text.length + mention.start,
              end: text.length + mention.end,
            });
          }
        }
        text += part.text;
        break;
      case "image":
        counts.webImages += 1;
        if (part.url.length > 0) imageUrls.push(part.url);
        break;
      case "localImage":
        counts.localImages += 1;
        if (part.path.length > 0) localImagePaths.push(part.path);
        break;
      case "localFile":
        counts.localFiles += 1;
        if (part.path.length > 0) localFilePaths.push(part.path);
        break;
    }
  }
  const attached = counts.webImages + counts.localImages + counts.localFiles;
  if (!text && attached === 0) return null;
  return {
    text,
    mentions,
    attachments: { ...counts, imageUrls, localImagePaths, localFilePaths },
  };
}

export function shouldPreservePendingMessages(
  threadStatus: Thread["status"],
): boolean {
  return (
    threadStatus === "starting" ||
    threadStatus === "active" ||
    threadStatus === "pending"
  );
}

export function turnRequestKind(
  decoded: ClientTurnRequestedEvent,
  acceptedClientRequest: AcceptedClientRequest | undefined,
): TimelineConversationTurnRequest["kind"] {
  const expectedTurnId =
    "expectedTurnId" in decoded.target ? decoded.target.expectedTurnId : null;
  return expectedTurnId === null ||
    (acceptedClientRequest !== undefined &&
      acceptedClientRequest.turnId !== expectedTurnId)
    ? "message"
    : "steer";
}

export function clientRequestUserMessages(
  decoded: ClientTurnRequestedEvent,
  meta: EventMeta,
  status: TimelineConversationTurnRequest["status"],
  acceptedClientRequest?: AcceptedClientRequest,
): UserMessage[] {
  const { target } = decoded;
  const targetTurnId =
    target.kind === "thread-start"
      ? null
      : (acceptedClientRequest?.turnId ??
        ("expectedTurnId" in target ? target.expectedTurnId : null));
  const kind = turnRequestKind(decoded, acceptedClientRequest);
  const rowMeta =
    acceptedClientRequest && kind === "steer"
      ? acceptedClientRequest.meta
      : meta;
  const messages: UserMessage[] = [];
  for (const input of decoded.inputGroups ?? [decoded.input]) {
    const parsedInput = parsePromptInput(input);
    if (!parsedInput) continue;
    const agentEnvelope = parseAgentMessageEnvelope(parsedInput.text);
    const initiator =
      decoded.initiator === "user" && agentEnvelope !== null
        ? "agent"
        : decoded.initiator;
    const suffix = messages.length > 0 ? `-${messages.length}` : "";
    messages.push({
      kind: "user",
      id: messageId(decoded.threadId, "user-seed", `${meta.seq}${suffix}`),
      threadId: decoded.threadId,
      sourceSeqStart: rowMeta.seq,
      sourceSeqEnd: rowMeta.seq,
      createdAt: rowMeta.createdAt,
      scope: targetTurnId ? turnScope(targetTurnId) : decoded.scope,
      role: "user",
      ...parsedInput,
      initiator,
      senderThreadId:
        decoded.senderThreadId ??
        (initiator === "agent"
          ? (agentEnvelope?.senderThreadId ?? null)
          : null),
      actorUserId: decoded.actorUserId ?? null,
      systemMessageKind: decoded.systemMessageKind ?? "unlabeled",
      systemMessageSubject: decoded.systemMessageSubject ?? null,
      turnRequest: {
        isGrouped: decoded.inputGroups !== undefined,
        kind,
        status,
      },
    });
  }
  return messages;
}

export function parseProviderUserMessage(
  decoded: ThreadEvent,
  meta: EventMeta,
): UserMessage | null {
  if (
    decoded.type !== "item/completed" ||
    decoded.item.type !== "userMessage"
  ) {
    return null;
  }
  const text = decoded.item.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
  if (text.length === 0) return null;
  return {
    kind: "user",
    id: messageId(decoded.threadId, "provider-input", decoded.item.id),
    threadId: decoded.threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    scope: decoded.scope,
    ...(decoded.item.parentToolCallId
      ? { parentToolCallId: decoded.item.parentToolCallId }
      : {}),
    role: "user",
    text,
    mentions: [],
    attachments: null,
    initiator: "system",
    senderThreadId: null,
    actorUserId: null,
    systemMessageKind: "unlabeled",
    systemMessageSubject: null,
    turnRequest: { isGrouped: false, kind: "steer", status: "accepted" },
  };
}
