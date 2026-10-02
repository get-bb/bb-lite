import {
  type ProviderUnhandledEvent,
  type ProvisioningTranscriptEntry,
  type ApprovalInteractionLifecycle,
  type PendingInteractionPermissionGrantApprovalSubject,
  type ThreadEvent,
  type SystemThreadInterruptedReason,
  type PluginInteractionLifecycle,
  type ThreadEventItemPresentation,
  type UserQuestionInteractionLifecycle,
  THREAD_CONTEXT_CLEAR_OPERATION,
  isApprovalInteractionLifecycle,
  isPluginInteractionLifecycle,
  isUserQuestionInteractionLifecycle,
  ownershipChangeOperationMetadataSchema,
} from "@bb/domain";
import type {
  EventProjectionOperationMessage,
  EventProjectionProvisioningMetadata,
  EventProjectionProvisioningTranscriptEntry,
  EventMeta,
  BuildEventProjectionMessagesOptions,
  EventProjectionPermissionGrantLifecycleMessage,
  EventProjectionUserQuestionLifecycleMessage,
  EventProjectionOwnershipChangeThreadOperationMetadata,
  EventProjectionThreadOperationMetadata,
  EventProjectionThreadOperationKind,
  EventProjectionThreadOperationStatus,
  EventProjectionPluginFormLifecycleMessage,
  EventProjectionErrorMessage,
} from "./event-projection-types.js";
import {
  assertNever,
  OWNERSHIP_CHANGE_VERBS,
  capitalize,
  messageId,
} from "./timeline-format.js";
import { getCompactionKey } from "./item-lifecycle.js";
import { getProviderModelFallbackData } from "./thread-state-extraction.js";

const HUMANIZED_EVENT_TOKEN_MAP: Record<string, string> = {
  api: "API",
  chatgpt: "ChatGPT",
  id: "ID",
  mcp: "MCP",
  oauth: "OAuth",
  sdk: "SDK",
  ui: "UI",
  url: "URL",
};

function splitCamelCaseToken(token: string): string[] {
  return token
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(" ")
    .filter((part) => part.length > 0);
}

function humanizeEventToken(token: string): string {
  const normalized = token.toLowerCase();
  const mapped = HUMANIZED_EVENT_TOKEN_MAP[normalized];
  if (mapped) return mapped;
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function humanizeRawType(rawType: string): string {
  const tokens = rawType
    .split(/[:/._-]+/u)
    .flatMap((token) => splitCamelCaseToken(token))
    .filter((token) => token.length > 0);
  return tokens.map((token) => humanizeEventToken(token)).join(" ");
}

export function buildProviderUnhandledDetail(
  event: ProviderUnhandledEvent,
): string {
  return [
    humanizeRawType(event.rawType),
    `Raw event: ${event.rawType}`,
    "Payload:",
    JSON.stringify(event.rawEvent, null, 2),
  ].join("\n");
}

export function readProvisioningTranscript(
  entries: ProvisioningTranscriptEntry[] | undefined,
): EventProjectionProvisioningTranscriptEntry[] | undefined {
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  const result: EventProjectionProvisioningTranscriptEntry[] = [];
  for (const entry of entries) {
    const key = entry.key.trim();
    if (!key) continue;
    const text = entry.text.trim();
    if (!text) continue;
    if (entry.type === "step") {
      result.push({
        type: "step",
        key,
        text,
        status: entry.status ?? "started",
        ...(entry.startedAt !== undefined
          ? { startedAt: entry.startedAt }
          : {}),
        ...(entry.metadata ? { metadata: entry.metadata } : {}),
      });
    } else if (entry.type === "output") {
      result.push({
        type: "output",
        key,
        text,
        ...(entry.startedAt !== undefined
          ? { startedAt: entry.startedAt }
          : {}),
        ...(entry.metadata ? { metadata: entry.metadata } : {}),
      });
    }
  }
  return result.length > 0 ? result : undefined;
}

export function provisioningKey(
  message: EventProjectionOperationMessage,
): string {
  return message.provisioning?.provisioningId ?? message.id;
}

export function provisioningTitleForStatus(
  status: EventProjectionOperationMessage["status"],
): string {
  switch (status) {
    case "completed":
      return "Provisioned thread";
    case "error":
      return "Provisioning thread failed";
    case "interrupted":
      return "Provisioning thread interrupted";
    case "pending":
    case undefined:
      return "Provisioning thread";
  }
}

function mergeTranscriptEntries(
  existing: EventProjectionProvisioningTranscriptEntry[] | undefined,
  incoming: EventProjectionProvisioningTranscriptEntry[] | undefined,
): EventProjectionProvisioningTranscriptEntry[] | undefined {
  const result = existing?.map((entry) => ({ ...entry })) ?? [];
  for (const entry of incoming ?? []) {
    const existingStepIndex =
      entry.type === "step"
        ? result.findIndex(
            (candidate) =>
              candidate.type === "step" && candidate.key === entry.key,
          )
        : -1;
    if (existingStepIndex === -1) {
      result.push({ ...entry });
    } else {
      result[existingStepIndex] = { ...entry };
    }
  }
  return result.length > 0 ? result : undefined;
}

export function mergeProvisioningMetadata(
  existing: EventProjectionProvisioningMetadata | undefined,
  incoming: EventProjectionProvisioningMetadata | undefined,
): EventProjectionProvisioningMetadata | undefined {
  if (!incoming) return existing ? { ...existing } : undefined;
  if (!existing) {
    return {
      ...incoming,
      ...(incoming.transcript
        ? { transcript: mergeTranscriptEntries(undefined, incoming.transcript) }
        : {}),
    };
  }
  const transcript = mergeTranscriptEntries(
    existing.transcript,
    incoming.transcript,
  );
  return {
    environmentId: incoming.environmentId ?? existing.environmentId,
    provisioningId: incoming.provisioningId,
    ...(transcript ? { transcript } : {}),
  };
}

type ParseOperationMessageOptions = Pick<
  BuildEventProjectionMessagesOptions,
  "includeDiagnosticOperations" | "providerDisplayName" | "threadName"
>;

function withThreadName(threadName: string, verb: string): string {
  const name = threadName.trim();
  return name.length > 0 ? `${name} ${verb}` : capitalize(verb);
}

type InteractionLifecycleEvent = Extract<
  ThreadEvent,
  { type: "system/interaction/lifecycle" }
>;

function providerDisplayName(
  providerId: string,
  projectedDisplayName: string | undefined,
): string {
  return projectedDisplayName?.trim() || providerId;
}

function normalizeThreadOperationKind(
  rawOperation: string,
): EventProjectionThreadOperationKind {
  if (rawOperation === "ownership_change") return "ownership_change";
  return "other";
}

function normalizeThreadOperationStatus(
  rawStatus: string,
): EventProjectionThreadOperationStatus {
  switch (rawStatus) {
    case "requested":
    case "queued":
    case "running":
    case "started":
    case "completed":
    case "failed":
    case "noop":
      return rawStatus;
    default:
      return "other";
  }
}

function createThreadOperationMetadata(
  decoded: Extract<ThreadEvent, { type: "system/operation" }>,
): EventProjectionThreadOperationMetadata {
  const operation = normalizeThreadOperationKind(decoded.operation);
  const base = {
    rawOperation: decoded.operation,
    status: normalizeThreadOperationStatus(decoded.status),
    rawStatus: decoded.status,
    operationId: decoded.operationId,
  };
  if (operation === "ownership_change") {
    const parsedMetadata = decoded.metadata
      ? ownershipChangeOperationMetadataSchema.safeParse(decoded.metadata)
      : null;
    return {
      ...base,
      operation,
      metadata: parsedMetadata?.success ? parsedMetadata.data : null,
    };
  }
  return {
    ...base,
    operation,
    ...(decoded.metadata ? { metadata: decoded.metadata } : {}),
  };
}

function threadInterruptedTitle(
  reason: SystemThreadInterruptedReason,
  cause?: "host-connection-lost",
): string {
  if (cause === "host-connection-lost") {
    return "Stopped — connection to host was lost";
  }
  switch (reason) {
    case "host-removed":
      return "Stopped because the machine was removed";
    case "manual-stop":
      return "Stopped manually";
    case "host-daemon-restarted":
      return "Stopped — host daemon restarted";
    case "provider-turn-idle":
      return "Stopped — provider turn stopped responding";
    default:
      return assertNever(reason);
  }
}

function ownershipTitleWithParent(
  threadName: string,
  verb: string,
  parentTitle: string | null,
): string {
  const parent =
    parentTitle !== null && parentTitle.trim().length > 0
      ? parentTitle.trim()
      : "parent";
  return withThreadName(threadName, `${verb} ${parent}`);
}

function ownershipChangeOperationTitle(
  meta: EventProjectionOwnershipChangeThreadOperationMetadata,
  threadName: string,
): string {
  if (meta.status === "failed") return "Ownership change failed";
  if (meta.status !== "completed") return `Ownership change ${meta.rawStatus}`;
  if (!meta.metadata) return "Ownership change completed";
  const { action } = meta.metadata;
  return ownershipTitleWithParent(
    threadName,
    OWNERSHIP_CHANGE_VERBS[action],
    action === "release"
      ? meta.metadata.previousParentThreadTitle
      : meta.metadata.nextParentThreadTitle,
  );
}

function threadOperationTitle(
  meta: EventProjectionThreadOperationMetadata | null,
  threadName: string,
): string {
  if (!meta) return "Operation update";
  switch (meta.operation) {
    case "ownership_change":
      return ownershipChangeOperationTitle(meta, threadName);
    case "other":
      if (
        meta.rawOperation === THREAD_CONTEXT_CLEAR_OPERATION &&
        meta.status === "completed"
      ) {
        return "Context cleared";
      }
      return `${capitalize(meta.rawOperation.replace(/_/g, " "))} ${
        meta.rawStatus
      }`;
    default:
      return assertNever(meta);
  }
}

const PROVISIONING_OPERATION_STATUSES = {
  active: "pending",
  completed: "completed",
  failed: "error",
  cancelled: "interrupted",
} as const;

function interactionMessageBase(
  decoded: InteractionLifecycleEvent,
  meta: EventMeta,
) {
  const { status } = decoded.interaction;
  return {
    threadId: decoded.threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    startedAt: meta.createdAt,
    scope: decoded.scope,
    interactionId: decoded.interaction.id,
    status:
      status === "resolved"
        ? ("completed" as const)
        : status === "interrupted"
          ? ("interrupted" as const)
          : ("pending" as const),
  };
}

function buildPermissionGrantLifecycleMessage(
  decoded: InteractionLifecycleEvent,
  interaction: ApprovalInteractionLifecycle,
  subject: PendingInteractionPermissionGrantApprovalSubject,
  meta: EventMeta,
): EventProjectionPermissionGrantLifecycleMessage {
  const decision = interaction.resolution?.decision;
  const { status, ...base } = interactionMessageBase(decoded, meta);
  return {
    kind: "permission-grant-lifecycle",
    id: messageId(decoded.threadId, "approval", interaction.id),
    ...base,
    lifecycle:
      interaction.status !== "resolved"
        ? interaction.status
        : decision === "deny"
          ? "denied"
          : "granted",
    status,
    approvalTarget: { itemId: subject.itemId, toolName: subject.toolName },
    grantScope:
      decision === "allow_once"
        ? "turn"
        : decision === "allow_for_session"
          ? "session"
          : null,
    statusReason: interaction.statusReason,
  };
}

function buildUserQuestionLifecycleMessage(
  decoded: InteractionLifecycleEvent,
  interaction: UserQuestionInteractionLifecycle,
  meta: EventMeta,
): EventProjectionUserQuestionLifecycleMessage {
  const { status, ...base } = interactionMessageBase(decoded, meta);
  return {
    kind: "user-question-lifecycle",
    id: messageId(decoded.threadId, "question", interaction.id),
    ...base,
    lifecycle:
      interaction.status === "resolved" ? "answered" : interaction.status,
    status,
    questions: interaction.payload.questions,
    answers: interaction.resolution?.answers ?? null,
    statusReason: interaction.statusReason,
  };
}

function pluginFormPresentation(
  interaction: PluginInteractionLifecycle,
): ThreadEventItemPresentation {
  const base = interaction.payload.presentation ?? {
    label: {
      pending: `Waiting for ${interaction.payload.title}`,
      completed: `Submitted ${interaction.payload.title}`,
    },
    icon: { glyph: "Toolbox" },
  };
  const description = interaction.resolution?.description;
  return {
    ...base,
    ...(description?.title === undefined ? {} : { title: description.title }),
    ...(description?.detail === undefined
      ? {}
      : { detail: description.detail }),
  };
}

function buildPluginFormLifecycleMessage(
  decoded: InteractionLifecycleEvent,
  interaction: PluginInteractionLifecycle,
  meta: EventMeta,
): EventProjectionPluginFormLifecycleMessage {
  const { status, ...base } = interactionMessageBase(decoded, meta);
  return {
    kind: "plugin-form-lifecycle",
    id: messageId(decoded.threadId, "form", interaction.id),
    ...base,
    lifecycle:
      interaction.status === "resolved"
        ? "submitted"
        : interaction.status === "interrupted"
          ? "cancelled"
          : "pending",
    status,
    pluginId: interaction.origin.pluginId,
    rendererId: interaction.origin.rendererId,
    title: interaction.payload.title,
    statusReason: interaction.statusReason,
    presentation: pluginFormPresentation(interaction),
    payload: interaction.resolution?.description?.payload ?? null,
  };
}

function buildInteractionLifecycleMessage(
  decoded: InteractionLifecycleEvent,
  meta: EventMeta,
):
  | EventProjectionPermissionGrantLifecycleMessage
  | EventProjectionUserQuestionLifecycleMessage
  | EventProjectionPluginFormLifecycleMessage
  | null {
  const { interaction } = decoded;
  if (isUserQuestionInteractionLifecycle(interaction)) {
    return buildUserQuestionLifecycleMessage(decoded, interaction, meta);
  }
  if (isPluginInteractionLifecycle(interaction)) {
    return buildPluginFormLifecycleMessage(decoded, interaction, meta);
  }
  if (!isApprovalInteractionLifecycle(interaction)) return null;
  const subject = interaction.payload.subject;
  return subject.kind === "permission_grant"
    ? buildPermissionGrantLifecycleMessage(decoded, interaction, subject, meta)
    : null;
}

function op(
  decoded: ThreadEvent,
  meta: EventMeta,
  idKey: string,
  fields: ViewOperationFields,
): EventProjectionOperationMessage {
  const completedAt = isTerminalOperationStatus(fields.status)
    ? meta.createdAt
    : null;
  return {
    kind: "operation",
    id: messageId(decoded.threadId, "op", `${idKey}:${meta.seq}`),
    threadId: decoded.threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    startedAt: meta.createdAt,
    completedAt,
    scope: decoded.scope,
    ...fields,
  };
}

function isTerminalOperationStatus(
  status: EventProjectionOperationMessage["status"],
): boolean {
  return (
    status === "completed" || status === "error" || status === "interrupted"
  );
}

type ViewOperationFields = Omit<
  EventProjectionOperationMessage,
  | "kind"
  | "id"
  | "threadId"
  | "sourceSeqStart"
  | "sourceSeqEnd"
  | "createdAt"
  | "startedAt"
  | "completedAt"
  | "scope"
  | "turnId"
>;

export function parseOperationMessage(
  decoded: ThreadEvent,
  meta: EventMeta,
  options?: ParseOperationMessageOptions,
):
  | EventProjectionOperationMessage
  | EventProjectionPermissionGrantLifecycleMessage
  | EventProjectionUserQuestionLifecycleMessage
  | EventProjectionPluginFormLifecycleMessage
  | null {
  const threadName = options?.threadName ?? "";
  const modelFallback = getProviderModelFallbackData(decoded);
  if (modelFallback !== null) {
    return op(decoded, meta, "warning", {
      opType: "warning",
      title: `Model fallback: ${modelFallback.originalModel} → ${modelFallback.fallbackModel}`,
      detail: modelFallback.message,
      status: "completed",
    });
  }
  if (decoded.type === "provider/unhandled") {
    if (options?.includeDiagnosticOperations !== true) return null;
    return op(decoded, meta, "provider-unhandled", {
      opType: "provider-unhandled",
      title: `Unhandled ${providerDisplayName(
        decoded.providerId,
        options?.providerDisplayName,
      )} event`,
      detail: buildProviderUnhandledDetail(decoded),
      status: "completed",
    });
  }
  if (decoded.type === "provider.env-resolved") {
    if (options?.includeDiagnosticOperations !== true) return null;
    const detail = decoded.entries
      .map((entry) => {
        const source =
          entry.source === "shell"
            ? "shell"
            : "plugin" in entry.source
              ? entry.source.plugin
              : entry.source.core;
        const value = typeof entry.value === "string" ? entry.value : "••••••";
        const reason = entry.reason ? ` — ${entry.reason}` : "";
        return `${entry.name}=${value} (${source})${reason}`;
      })
      .join("\n");
    return op(decoded, meta, "provider-environment", {
      opType: "provider-environment",
      title: "Provider environment resolved",
      detail: detail || undefined,
      status: "completed",
    });
  }
  if (decoded.type === "provider/warning") {
    const category = decoded.category;
    const isDeprecation = category === "deprecation";
    const isConfig = category === "config";
    const title = isDeprecation
      ? "Deprecation notice"
      : isConfig
        ? "Configuration warning"
        : decoded.summary?.trim() || "Warning";
    const detail = (
      isDeprecation || isConfig
        ? [decoded.summary, decoded.details]
        : [decoded.details]
    )
      .filter((line): line is string => Boolean(line))
      .join("\n");
    return op(decoded, meta, isDeprecation ? "deprecation" : "warning", {
      opType: isDeprecation ? "deprecation" : "warning",
      title,
      detail: detail.length > 0 ? detail : undefined,
      status: "completed",
    });
  }
  if (decoded.type === "system/thread/interrupted") {
    return op(decoded, meta, "thread-interrupted", {
      opType: "thread-interrupted",
      title: threadInterruptedTitle(decoded.reason, decoded.cause),
      status: "interrupted",
    });
  }
  if (decoded.type === "system/thread-provisioning") {
    const { status, environmentId, provisioningId } = decoded;
    if (provisioningId.startsWith("thread-start:")) return null;
    const transcript = readProvisioningTranscript(decoded.entries);
    const operationStatus = PROVISIONING_OPERATION_STATUSES[status];
    return op(decoded, meta, "thread-provisioning", {
      opType: "thread-provisioning",
      title: provisioningTitleForStatus(operationStatus),
      status: operationStatus,
      provisioning: {
        ...(environmentId !== null ? { environmentId } : {}),
        provisioningId,
        ...(transcript ? { transcript } : {}),
      },
    });
  }
  if (decoded.type === "thread/name/updated") return null;
  if (decoded.type === "system/operation") {
    if (
      decoded.operation === "plugin_interaction" ||
      decoded.operation === "edit_message"
    ) {
      return null;
    }
    const threadOperation = createThreadOperationMetadata(decoded);
    const title = threadOperationTitle(threadOperation, threadName);
    const branch =
      typeof decoded.metadata?.branch === "string"
        ? decoded.metadata.branch
        : undefined;
    const messageDetail = decoded.message.trim();
    const detailParts = [
      messageDetail.length > 0 && messageDetail !== title
        ? messageDetail
        : undefined,
      branch ? `Branch: ${branch}` : undefined,
    ].filter((value): value is string => Boolean(value));
    return op(decoded, meta, "operation", {
      opType: "operation",
      title,
      detail: detailParts.length > 0 ? detailParts.join(" • ") : undefined,
      status:
        threadOperation.status === "completed" ||
        threadOperation.status === "noop"
          ? "completed"
          : threadOperation.status === "failed"
            ? "error"
            : "pending",
      threadOperation,
    });
  }
  if (decoded.type === "system/interaction/lifecycle") {
    return buildInteractionLifecycleMessage(decoded, meta);
  }
  if (decoded.type === "thread/compacted") {
    return {
      ...op(decoded, meta, `compaction`, {
        opType: "compaction",
        title: "Context compacted",
        status: "completed",
      }),
      id: messageId(
        decoded.threadId,
        "op",
        `compaction:${getCompactionKey(decoded, meta)}`,
      ),
    };
  }
  if (decoded.type === "thread/context/cleared") {
    return op(decoded, meta, "context-clear", {
      opType: "context-clear",
      title: "Context cleared",
      status: "completed",
    });
  }
  return null;
}

export function interruptOperationMessage(
  message: EventProjectionOperationMessage,
): void {
  if (message.status !== "pending") return;
  message.status = "interrupted";
  message.completedAt = message.createdAt;
  switch (message.opType) {
    case "operation":
      message.title = "Operation interrupted";
      return;
    case "thread-provisioning":
      message.title = provisioningTitleForStatus("interrupted");
      return;
    case "compaction":
      message.title = "Context compaction interrupted";
      return;
    case "context-clear":
      message.title = "Context clear interrupted";
      return;
    default:
      return;
  }
}

export function finalizeOperationMessage(
  message: EventProjectionOperationMessage,
  options: BuildEventProjectionMessagesOptions | undefined,
): void {
  if (message.status !== "pending") return;
  if (options?.threadStatus === "error") {
    switch (message.opType) {
      case "thread-provisioning":
        message.status = "error";
        message.title = provisioningTitleForStatus("error");
        message.completedAt = message.createdAt;
        return;
      default:
        break;
    }
  }
  interruptOperationMessage(message);
}

export function parseErrorMessage(
  decoded: ThreadEvent,
  meta: EventMeta,
): EventProjectionErrorMessage | null {
  if (decoded.type !== "provider/error" && decoded.type !== "system/error")
    return null;
  const { message, detail } = decoded;
  return {
    kind: "error",
    id: messageId(decoded.threadId, "error", `${meta.seq}`),
    threadId: decoded.threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    scope: decoded.scope,
    rawType: decoded.type,
    message: message || "Error event",
    detail: detail && detail !== message ? detail : null,
    ...(decoded.type === "provider/error" && decoded.errorInfo
      ? { providerErrorInfo: decoded.errorInfo }
      : {}),
    ...(decoded.type === "provider/error" && decoded.willRetry !== undefined
      ? { willRetry: decoded.willRetry }
      : {}),
  };
}
