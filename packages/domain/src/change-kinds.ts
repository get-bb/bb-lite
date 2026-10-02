import { z } from "zod";
import {
  threadEventTypeValues,
  type ThreadEventType,
} from "./provider-event.js";
import {
  threadActivityStateSchema,
  threadRuntimeStateSchema,
  threadStatusSchema,
} from "./thread.js";

export const THREAD_CHANGE_KINDS = [
  "thread-created",
  "thread-deleted",
  "events-appended",
  "history-rewritten",
  "interactions-changed",
  "status-changed",
  "title-changed",
  "queue-changed",
  "archived-changed",
  "pin-state-changed",
  "parent-changed",
  "environment-changed",
  "read-state-changed",
  "tabs-changed",
  "terminals-changed",
] as const;
export type ThreadChangeKind = (typeof THREAD_CHANGE_KINDS)[number];

export const PROJECT_CHANGE_KINDS = [
  "project-created",
  "project-updated",
  "project-deleted",
  "project-sources-changed",
  "threads-changed",
] as const;
export type ProjectChangeKind = (typeof PROJECT_CHANGE_KINDS)[number];

export const ENVIRONMENT_CHANGE_KINDS = [
  "environment-created",
  "environment-deleted",
  "metadata-changed",
  "status-changed",
  "work-status-changed",
  "git-refs-changed",
] as const;
export type EnvironmentChangeKind = (typeof ENVIRONMENT_CHANGE_KINDS)[number];

export const HOST_CHANGE_KINDS = [
  "host-connected",
  "host-disconnected",
  "provider-model-catalog-changed",
] as const;
export type HostChangeKind = (typeof HOST_CHANGE_KINDS)[number];

export const SYSTEM_CHANGE_KINDS = [
  "config-changed",
  "plugins-changed",
  "ui-preferences-changed",
] as const;
export type SystemChangeKind = (typeof SYSTEM_CHANGE_KINDS)[number];

function target<Kind extends string, Shape extends z.ZodRawShape>(
  kind: Kind,
  scope: Shape,
) {
  return z.object({ kind: z.literal(kind), ...scope }).strict();
}

const targetId = z.string().min(1);
export const realtimeSubscriptionTargetSchema = z.discriminatedUnion("kind", [
  target("thread-detail", { threadId: targetId }),
  target("thread-list", {}),
  target("project-list", {}),
  target("environment-detail", { environmentId: targetId }),
  target("environment-list", {}),
  target("host-list", {}),
  target("system", {}),
]);
export type RealtimeSubscriptionTarget = z.infer<
  typeof realtimeSubscriptionTargetSchema
>;

const subscribeMessageSchema = z.object({
  type: z.literal("subscribe"),
  target: realtimeSubscriptionTargetSchema,
});

const unsubscribeMessageSchema = z.object({
  type: z.literal("unsubscribe"),
  target: realtimeSubscriptionTargetSchema,
});

export const pingMessageSchema = z.object({
  type: z.literal("ping"),
});

export const clientMessageSchema = z.discriminatedUnion("type", [
  subscribeMessageSchema,
  unsubscribeMessageSchema,
  pingMessageSchema,
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export function realtimeSubscriptionTargetKey(
  target: RealtimeSubscriptionTarget,
): string {
  const { kind, ...scope } = target;
  const [id] = Object.values(scope);
  return id === undefined ? kind : `${kind}:${id}`;
}

const threadStatusChangeMetadataSchema = z
  .object({
    status: threadStatusSchema,
    runtime: threadRuntimeStateSchema,
    activity: threadActivityStateSchema,
    latestAttentionAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();

export interface ThreadChangeMetadata {
  backgroundActivityChanged?: boolean;
  eventTypes?: readonly ThreadEventType[];
  hasPendingInteraction?: boolean;
  projectId?: string;
  statusChange?: z.infer<typeof threadStatusChangeMetadataSchema>;
}

interface Changed<Entity extends string, Kind extends string> {
  type: "changed";
  entity: Entity;
  id?: string;
  changes: readonly Kind[];
}

export type ChangedMessage =
  | (Changed<"thread", ThreadChangeKind> & { metadata?: ThreadChangeMetadata })
  | Changed<"project", ProjectChangeKind>
  | Changed<"environment", EnvironmentChangeKind>
  | Changed<"host", HostChangeKind>
  | Omit<Changed<"system", SystemChangeKind>, "id">;

function lenientKinds<TKind extends string>(kinds: readonly TKind[]) {
  const known: ReadonlySet<string> = new Set(kinds);
  return z
    .array(z.string())
    .transform((values) =>
      values.filter((value): value is TKind => known.has(value)),
    );
}

const knownThreadEventTypes: ReadonlySet<string> = new Set(
  threadEventTypeValues,
);

const threadChangeMetadataLenientSchema = z.object({
  backgroundActivityChanged: z.boolean().optional(),
  eventTypes: z
    .array(z.string())
    .transform((values) =>
      values.filter((value): value is ThreadEventType =>
        knownThreadEventTypes.has(value),
      ),
    )
    .optional(),
  hasPendingInteraction: z.boolean().optional(),
  projectId: z.string().optional(),
  statusChange: threadStatusChangeMetadataSchema.optional().catch(undefined),
});

const threadChangedMessageLenientSchema = z.object({
  type: z.literal("changed"),
  entity: z.literal("thread"),
  id: z.string().optional(),
  metadata: threadChangeMetadataLenientSchema.optional(),
  changes: lenientKinds(THREAD_CHANGE_KINDS),
});

function changedLenient<Entity extends string, Kind extends string>(
  entity: Entity,
  kinds: readonly Kind[],
) {
  return z.object({
    type: z.literal("changed"),
    entity: z.literal(entity),
    id: z.string().optional(),
    changes: lenientKinds(kinds),
  });
}

const systemChangedMessageLenientSchema = z.object({
  type: z.literal("changed"),
  entity: z.literal("system"),
  changes: lenientKinds(SYSTEM_CHANGE_KINDS),
});

export const changedMessageLenientSchema = z.discriminatedUnion("entity", [
  threadChangedMessageLenientSchema,
  changedLenient("project", PROJECT_CHANGE_KINDS),
  changedLenient("environment", ENVIRONMENT_CHANGE_KINDS),
  changedLenient("host", HOST_CHANGE_KINDS),
  systemChangedMessageLenientSchema,
]);
