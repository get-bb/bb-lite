import {
  THREAD_CONTEXT_CLEAR_OPERATION,
  isApprovalInteractionLifecycle,
  isPluginInteractionLifecycle,
  isUserQuestionInteractionLifecycle,
  ownershipChangeOperationMetadataSchema,
  type OwnershipChangeOperationMetadata,
  type PluginInteractionLifecycle,
  type ProvisioningTranscriptEntry,
  type ThreadEvent,
  type ThreadEventItemPresentation,
} from "@bb/domain";
import type { TimelineRowStatus } from "@bb/server-contract";
import type {
  ErrorMessage,
  EventMeta,
  InteractionMessage,
  OperationMessage,
  ProjectionOptions,
} from "./event-projection-types.js";
import {
  capitalize,
  messageId,
  OWNERSHIP_CHANGE_VERBS,
} from "./timeline-format.js";

type EventOfType<Type extends ThreadEvent["type"]> = Extract<
  ThreadEvent,
  { type: Type }
>;

function readProvisioningTranscript(
  entries: ProvisioningTranscriptEntry[],
): ProvisioningTranscriptEntry[] | undefined {
  const result = entries.flatMap((entry) => {
    const key = entry.key.trim();
    const text = entry.text.trim();
    if (!key || !text) return [];
    const status =
      entry.type === "step" ? (entry.status ?? "started") : undefined;
    return [{ ...entry, key, text, status }];
  });
  return result.length > 0 ? result : undefined;
}

const PROVISIONING_TITLES: Record<TimelineRowStatus, string> = {
  pending: "Provisioning thread",
  completed: "Provisioned thread",
  error: "Provisioning thread failed",
  interrupted: "Provisioning thread interrupted",
};

export function provisioningTitleForStatus(status: TimelineRowStatus): string {
  return PROVISIONING_TITLES[status];
}

export function mergeTranscriptEntries(
  existing: ProvisioningTranscriptEntry[] | undefined,
  incoming: ProvisioningTranscriptEntry[] | undefined,
): ProvisioningTranscriptEntry[] | undefined {
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

function withThreadName(threadName: string, verb: string): string {
  const name = threadName.trim();
  return name.length > 0 ? `${name} ${verb}` : capitalize(verb);
}

const THREAD_INTERRUPTED_TITLES = {
  "host-removed": "Stopped because the machine was removed",
  "manual-stop": "Stopped manually",
  "host-daemon-restarted": "Stopped — host daemon restarted",
  "provider-turn-idle": "Stopped — provider turn stopped responding",
};

function ownershipChangeTitle(
  decoded: EventOfType<"system/operation">,
  metadata: OwnershipChangeOperationMetadata | null,
  threadName: string,
): string {
  if (decoded.status === "failed") return "Ownership change failed";
  if (decoded.status !== "completed") {
    return `Ownership change ${decoded.status}`;
  }
  if (!metadata) return "Ownership change completed";
  const parentTitle =
    metadata.action === "release"
      ? metadata.previousParentThreadTitle
      : metadata.nextParentThreadTitle;
  const verb = OWNERSHIP_CHANGE_VERBS[metadata.action];
  return withThreadName(
    threadName,
    `${verb} ${parentTitle?.trim() || "parent"}`,
  );
}

function threadOperationMessage(
  decoded: EventOfType<"system/operation">,
  meta: EventMeta,
  threadName: string,
): OperationMessage {
  const { operation, status } = decoded;
  const ownershipChange = operation === "ownership_change";
  const parsed =
    ownershipChange && decoded.metadata
      ? ownershipChangeOperationMetadataSchema.safeParse(decoded.metadata)
      : null;
  const metadata = parsed?.success ? parsed.data : null;
  const title = ownershipChange
    ? ownershipChangeTitle(decoded, metadata, threadName)
    : operation === THREAD_CONTEXT_CLEAR_OPERATION && status === "completed"
      ? "Context cleared"
      : `${capitalize(operation.replace(/_/g, " "))} ${status}`;
  const branch = decoded.metadata?.branch;
  const messageDetail = decoded.message.trim();
  const detailParts = [
    messageDetail.length > 0 && messageDetail !== title ? messageDetail : "",
    typeof branch === "string" && branch ? `Branch: ${branch}` : "",
  ].filter(Boolean);
  return op(decoded, meta, {
    opType: "operation",
    title,
    detail: detailParts.length > 0 ? detailParts.join(" • ") : undefined,
    status:
      status === "completed" || status === "noop"
        ? "completed"
        : status === "failed"
          ? "error"
          : "pending",
    mergeKey: decoded.operationId,
    parentChange: metadata && {
      action: metadata.action,
      previousParentThreadId: metadata.previousParentThreadId,
      previousParentThreadTitle: metadata.previousParentThreadTitle,
      nextParentThreadId: metadata.nextParentThreadId,
      nextParentThreadTitle: metadata.nextParentThreadTitle,
    },
  });
}

const PROVISIONING_OPERATION_STATUSES = {
  active: "pending",
  completed: "completed",
  failed: "error",
  cancelled: "interrupted",
} as const;

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

function buildInteractionLifecycleMessage(
  decoded: EventOfType<"system/interaction/lifecycle">,
  meta: EventMeta,
): InteractionMessage | null {
  const { interaction } = decoded;
  const { status, statusReason } = interaction;
  const base = (workKind: InteractionMessage["workKind"]) => ({
    id: messageId(decoded.threadId, workKind, interaction.id),
    threadId: decoded.threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    startedAt: meta.createdAt,
    scope: decoded.scope,
    kind: "interaction" as const,
  });
  const common = {
    status:
      status === "resolved"
        ? ("completed" as const)
        : status === "interrupted"
          ? ("interrupted" as const)
          : ("pending" as const),
    interactionId: interaction.id,
  };
  if (isUserQuestionInteractionLifecycle(interaction)) {
    return {
      ...base("question"),
      workKind: "question",
      ...common,
      lifecycle: status === "resolved" ? "answered" : status,
      questions: interaction.payload.questions,
      answers: interaction.resolution?.answers ?? null,
      statusReason,
    };
  }
  if (isPluginInteractionLifecycle(interaction)) {
    return {
      ...base("form"),
      workKind: "form",
      ...common,
      lifecycle:
        status === "resolved"
          ? "submitted"
          : status === "interrupted"
            ? "cancelled"
            : "pending",
      pluginId: interaction.origin.pluginId,
      rendererId: interaction.origin.rendererId,
      title: interaction.payload.title,
      statusReason,
      presentation: pluginFormPresentation(interaction),
      payload: interaction.resolution?.description?.payload ?? null,
    };
  }
  if (!isApprovalInteractionLifecycle(interaction)) return null;
  const { subject } = interaction.payload;
  if (subject.kind !== "permission_grant") return null;
  const decision = interaction.resolution?.decision;
  return {
    ...base("approval"),
    workKind: "approval",
    ...common,
    approvalKind: "permission-grant",
    lifecycle:
      status !== "resolved"
        ? status
        : decision === "deny"
          ? "denied"
          : "granted",
    grantScope:
      decision === "allow_once"
        ? "turn"
        : decision === "allow_for_session"
          ? "session"
          : null,
    statusReason,
    target: { itemId: subject.itemId, toolName: subject.toolName },
  };
}

type OperationFields = Omit<
  OperationMessage,
  | "kind"
  | "id"
  | "threadId"
  | "sourceSeqStart"
  | "sourceSeqEnd"
  | "createdAt"
  | "startedAt"
  | "completedAt"
  | "scope"
>;

function op(
  decoded: ThreadEvent,
  meta: EventMeta,
  fields: OperationFields,
): OperationMessage {
  return {
    kind: "operation",
    id: messageId(decoded.threadId, "op", `${fields.opType}:${meta.seq}`),
    threadId: decoded.threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    startedAt: meta.createdAt,
    completedAt: fields.status === "pending" ? null : meta.createdAt,
    scope: decoded.scope,
    ...fields,
  };
}

function environmentDetail(
  decoded: EventOfType<"provider.env-resolved">,
): string {
  return decoded.entries
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
}

function warningMessage(
  decoded: EventOfType<"provider/warning">,
  meta: EventMeta,
): OperationMessage {
  const { category, summary, details } = decoded;
  const labeled = category === "deprecation" || category === "config";
  const detail = (labeled ? [summary, details] : [details])
    .filter(Boolean)
    .join("\n");
  return op(decoded, meta, {
    opType: category === "deprecation" ? "deprecation" : "warning",
    title:
      category === "deprecation"
        ? "Deprecation notice"
        : category === "config"
          ? "Configuration warning"
          : summary?.trim() || "Warning",
    detail: detail.length > 0 ? detail : undefined,
    status: "completed",
  });
}

export function parseOperationMessage(
  decoded: ThreadEvent,
  meta: EventMeta,
  options: ProjectionOptions,
): OperationMessage | InteractionMessage | null {
  switch (decoded.type) {
    case "provider/modelFallback":
      return op(decoded, meta, {
        opType: "warning",
        title: `Model fallback: ${decoded.originalModel} → ${decoded.fallbackModel}`,
        detail: decoded.message,
        status: "completed",
      });
    case "provider.env-resolved":
      if (!options.includeDiagnosticOperations) return null;
      return op(decoded, meta, {
        opType: "provider-environment",
        title: "Provider environment resolved",
        detail: environmentDetail(decoded) || undefined,
        status: "completed",
      });
    case "provider/warning":
      return warningMessage(decoded, meta);
    case "system/thread/interrupted":
      return op(decoded, meta, {
        opType: "thread-interrupted",
        title:
          decoded.cause === "host-connection-lost"
            ? "Stopped — connection to host was lost"
            : THREAD_INTERRUPTED_TITLES[decoded.reason],
        status: "interrupted",
      });
    case "system/thread-provisioning": {
      const { provisioningId } = decoded;
      if (provisioningId.startsWith("thread-start:")) return null;
      const status = PROVISIONING_OPERATION_STATUSES[decoded.status];
      return op(decoded, meta, {
        opType: "thread-provisioning",
        title: provisioningTitleForStatus(status),
        status,
        mergeKey: provisioningId,
        transcript: readProvisioningTranscript(decoded.entries),
      });
    }
    case "system/operation":
      return decoded.operation === "plugin_interaction" ||
        decoded.operation === "edit_message"
        ? null
        : threadOperationMessage(decoded, meta, options.threadName);
    case "system/interaction/lifecycle":
      return buildInteractionLifecycleMessage(decoded, meta);
    case "thread/context/cleared":
      return op(decoded, meta, {
        opType: "context-clear",
        title: "Context cleared",
        status: "completed",
      });
    default:
      return null;
  }
}

const INTERRUPTED_OPERATION_TITLES: Partial<
  Record<OperationMessage["opType"], string>
> = {
  operation: "Operation interrupted",
  "thread-provisioning": PROVISIONING_TITLES.interrupted,
  compaction: "Context compaction interrupted",
  "context-clear": "Context clear interrupted",
};

export function interruptOperationMessage(message: OperationMessage): void {
  if (message.status !== "pending") return;
  message.status = "interrupted";
  message.completedAt = message.createdAt;
  message.title = INTERRUPTED_OPERATION_TITLES[message.opType] ?? message.title;
}

export function finalizeOperationMessage(
  message: OperationMessage,
  options: ProjectionOptions,
): void {
  if (message.status !== "pending") return;
  if (
    options.threadStatus === "error" &&
    message.opType === "thread-provisioning"
  ) {
    message.status = "error";
    message.title = PROVISIONING_TITLES.error;
    message.completedAt = message.createdAt;
    return;
  }
  interruptOperationMessage(message);
}

export function parseErrorMessage(
  decoded: ThreadEvent,
  meta: EventMeta,
): ErrorMessage | null {
  if (decoded.type !== "provider/error" && decoded.type !== "system/error") {
    return null;
  }
  const { message, detail } = decoded;
  const provider = decoded.type === "provider/error" ? decoded : null;
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
    ...(provider?.errorInfo ? { providerErrorInfo: provider.errorInfo } : {}),
    ...(provider?.willRetry !== undefined
      ? { willRetry: provider.willRetry }
      : {}),
  };
}
