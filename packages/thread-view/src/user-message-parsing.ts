import {
  type ClientTurnRequestId,
  type ThreadEvent,
  requireThreadEventScopeTurnId,
  type PromptInput,
  type PromptTextMention,
} from "@bb/domain";
import {
  type EventMeta,
  type BuildEventProjectionMessagesOptions,
  type EventProjectionTurnRequestKind,
  type EventProjectionTurnRequest,
  type EventProjectionUserMessage,
  eventProjectionMessageTurnScopeFields,
} from "./event-projection-types.js";
import { messageId, parseAgentMessageEnvelope } from "./timeline-format.js";

export type ThreadEventWithMetaLike = { event: ThreadEvent; meta: EventMeta };

export type AcceptedClientRequest = { meta: EventMeta; turnId: string };

export function buildAcceptedClientRequestById(
  events: readonly ThreadEventWithMetaLike[],
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

export function parsePromptInput(
  input: ReadonlyArray<PromptInput> | undefined,
): {
  text: string;
  webImages: number;
  localImages: number;
  localFiles: number;
  imageUrls: string[];
  localImagePaths: string[];
  localFilePaths: string[];
  mentions: PromptTextMention[];
} | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const textParts: string[] = [];
  let webImages = 0;
  let localImages = 0;
  let localFiles = 0;
  const imageUrls: string[] = [];
  const localImagePaths: string[] = [];
  const localFilePaths: string[] = [];
  const mentions: PromptTextMention[] = [];
  let textOffset = 0;
  for (const part of input) {
    if (part.visibility === "agent-only") continue;
    switch (part.type) {
      case "text":
        if (part.text.length > 0) {
          for (const mention of part.mentions) {
            if (
              mention.start >= 0 &&
              mention.end > mention.start &&
              mention.end <= part.text.length
            ) {
              mentions.push({
                ...mention,
                start: textOffset + mention.start,
                end: textOffset + mention.end,
              });
            }
          }
          textParts.push(part.text);
          textOffset += part.text.length;
        }
        break;
      case "image":
        webImages += 1;
        if (part.url.length > 0) imageUrls.push(part.url);
        break;
      case "localImage":
        localImages += 1;
        if (part.path.length > 0) localImagePaths.push(part.path);
        break;
      case "localFile":
        localFiles += 1;
        if (part.path.length > 0) localFilePaths.push(part.path);
        break;
    }
  }
  const text = textParts.join("");
  if (!text && webImages === 0 && localImages === 0 && localFiles === 0) {
    return null;
  }
  return {
    text,
    webImages,
    localImages,
    localFiles,
    imageUrls,
    localImagePaths,
    localFilePaths,
    mentions,
  };
}

export function shouldPreservePendingMessages(
  threadStatus: BuildEventProjectionMessagesOptions["threadStatus"] | undefined,
): boolean {
  return (
    threadStatus === "starting" ||
    threadStatus === "active" ||
    threadStatus === "pending"
  );
}

interface ParseUserFromClientRequestArgs {
  acceptedClientRequest?: AcceptedClientRequest;
  decoded: ThreadEvent;
  meta: EventMeta;
  options?: BuildEventProjectionMessagesOptions;
}

type ClientTurnRequestedEvent = Extract<
  ThreadEvent,
  { type: "client/turn/requested" }
>;

function resolveTurnRequestKind(
  decoded: ClientTurnRequestedEvent,
  acceptedClientRequest: AcceptedClientRequest | undefined,
): EventProjectionTurnRequestKind {
  const expectedTurnId =
    "expectedTurnId" in decoded.target ? decoded.target.expectedTurnId : null;
  return expectedTurnId === null ||
    (acceptedClientRequest !== undefined &&
      acceptedClientRequest.turnId !== expectedTurnId)
    ? "message"
    : "steer";
}

function buildClientUserMessages(
  decoded: ClientTurnRequestedEvent,
  meta: EventMeta,
  requestStatus: EventProjectionTurnRequest["status"],
  acceptedClientRequest?: AcceptedClientRequest,
): EventProjectionUserMessage[] {
  const targetTurnId =
    decoded.target.kind === "thread-start"
      ? null
      : (acceptedClientRequest?.turnId ??
        ("expectedTurnId" in decoded.target
          ? decoded.target.expectedTurnId
          : null));
  const messages: EventProjectionUserMessage[] = [];
  for (const input of decoded.inputGroups ?? [decoded.input]) {
    const parsedInput = parsePromptInput(input);
    if (!parsedInput) continue;
    const turnRequest: EventProjectionTurnRequest = {
      isGrouped: decoded.inputGroups !== undefined,
      kind: resolveTurnRequestKind(decoded, acceptedClientRequest),
      status: requestStatus,
    };
    const rowMeta =
      acceptedClientRequest && turnRequest.kind === "steer"
        ? acceptedClientRequest.meta
        : meta;
    const agentEnvelope = parseAgentMessageEnvelope(parsedInput.text);
    const initiator =
      decoded.initiator === "user" && agentEnvelope !== null
        ? "agent"
        : decoded.initiator;
    messages.push({
      kind: "user",
      id: messageId(
        decoded.threadId,
        "user-seed",
        messages.length > 0 ? `${meta.seq}-${messages.length}` : `${meta.seq}`,
      ),
      threadId: decoded.threadId,
      sourceSeqStart: rowMeta.seq,
      sourceSeqEnd: rowMeta.seq,
      createdAt: rowMeta.createdAt,
      ...(targetTurnId
        ? eventProjectionMessageTurnScopeFields(targetTurnId)
        : { scope: decoded.scope }),
      initiator,
      senderThreadId:
        decoded.senderThreadId ??
        (initiator === "agent"
          ? (agentEnvelope?.senderThreadId ?? null)
          : null),
      systemMessageKind: decoded.systemMessageKind ?? "unlabeled",
      systemMessageSubject: decoded.systemMessageSubject ?? null,
      turnRequest,
      text: parsedInput.text,
      mentions: parsedInput.mentions,
      attachments: {
        webImages: parsedInput.webImages,
        localImages: parsedInput.localImages,
        localFiles: parsedInput.localFiles,
        ...(parsedInput.imageUrls.length > 0
          ? { imageUrls: parsedInput.imageUrls }
          : {}),
        ...(parsedInput.localImagePaths.length > 0
          ? { localImagePaths: parsedInput.localImagePaths }
          : {}),
        ...(parsedInput.localFilePaths.length > 0
          ? { localFilePaths: parsedInput.localFilePaths }
          : {}),
      },
    });
  }
  return messages;
}

export function parseUsersFromClientRequest(
  args: ParseUserFromClientRequestArgs,
): EventProjectionUserMessage[] {
  const { acceptedClientRequest, decoded, meta, options } = args;
  if (
    decoded.type !== "client/turn/requested" ||
    !options?.threadStatus ||
    resolveTurnRequestKind(decoded, acceptedClientRequest) !== "message"
  ) {
    return [];
  }
  return buildClientUserMessages(
    decoded,
    meta,
    acceptedClientRequest ? "accepted" : "pending",
    acceptedClientRequest,
  );
}

export function parsePendingSteersFromClientRequest(
  args: ParseUserFromClientRequestArgs,
): EventProjectionUserMessage[] {
  const { acceptedClientRequest, decoded, meta, options } = args;
  if (
    acceptedClientRequest ||
    decoded.type !== "client/turn/requested" ||
    resolveTurnRequestKind(decoded, undefined) !== "steer" ||
    !shouldPreservePendingMessages(options?.threadStatus)
  ) {
    return [];
  }
  return buildClientUserMessages(decoded, meta, "pending");
}

export function parseAcceptedSteersFromClientRequest(
  args: ParseUserFromClientRequestArgs & {
    acceptedClientRequest: AcceptedClientRequest;
  },
): EventProjectionUserMessage[] {
  const { acceptedClientRequest, decoded, meta, options } = args;
  if (
    decoded.type !== "client/turn/requested" ||
    resolveTurnRequestKind(decoded, acceptedClientRequest) !== "steer" ||
    !options?.threadStatus
  ) {
    return [];
  }
  return buildClientUserMessages(
    decoded,
    meta,
    "accepted",
    acceptedClientRequest,
  );
}

export function parseRejectedUsersFromClientRequest(
  args: Omit<ParseUserFromClientRequestArgs, "acceptedClientRequest">,
): EventProjectionUserMessage[] {
  const { decoded, meta, options } = args;
  if (decoded.type !== "client/turn/requested" || !options?.threadStatus) {
    return [];
  }
  return buildClientUserMessages(decoded, meta, "rejected");
}

export function parseProviderUserMessage(
  decoded: ThreadEvent,
  meta: EventMeta,
): EventProjectionUserMessage | null {
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
    initiator: "system",
    senderThreadId: null,
    systemMessageKind: "unlabeled",
    systemMessageSubject: null,
    turnRequest: { isGrouped: false, kind: "steer", status: "accepted" },
    text,
    mentions: [],
  };
}
