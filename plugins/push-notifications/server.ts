import { randomUUID } from "node:crypto";
import {
  OpError,
  interactions,
  server,
  threads,
  type PluginServerApi,
} from "@bb/plugin";
import type { PendingInteraction, Thread } from "@bb/domain";
import {
  DEFAULT_EXPO_PUSH_URL,
  lastSendOutcomeSchema,
  pushNotifications,
  pushSubscriptionSchema,
  type ClientNotification,
  type LastSendOutcome,
  type PushSubscription,
} from "./contract.js";
import { notificationPreviewText, truncate } from "./notification-text.js";
import {
  deliver,
  describePendingInteraction,
  errorLine,
  fetchRelay,
  threadDisplayTitle,
  type PushKind,
} from "./sender.js";

const COALESCE_MS = 2_000;
const PREFIX = "subscription:";
const LAST_OUTCOME_KEY = "last-send-outcome";
const KIND_PRIORITY: readonly PushKind[] = [
  "pending-interaction",
  "thread-error",
  "turn-finished",
];
const FALLBACK_BODIES: Record<PushKind, string> = {
  "pending-interaction": "Waiting for your input",
  "thread-error": "The thread hit an error",
  "turn-finished": "Finished and waiting for you",
};

interface Pending {
  bodies: Map<PushKind, string>;
  eventAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export default function pushNotificationsServer(bb: PluginServerApi): void {
  const settings = bb.settings.define({
    mobileEnabled: {
      type: "boolean",
      label: "Mobile notifications",
      description: "Send push messages to your registered phones and tablets.",
      default: true,
    },
    webEnabled: {
      type: "boolean",
      label: "Web notifications",
      description:
        "Show system notifications while bb is open in a browser. Each browser needs notification permission.",
      default: true,
    },
    desktopEnabled: {
      type: "boolean",
      label: "Desktop notifications",
      description:
        "Show system notifications while the bb desktop app is running.",
      default: true,
    },
    expoPushUrl: {
      type: "string",
      label: "Expo push relay URL",
      description: "The Expo push relay endpoint used for mobile delivery.",
      default: DEFAULT_EXPO_PUSH_URL,
    },
  });
  const notification = bb.provide(pushNotifications.notification, null);
  const pending = new Map<string, Pending>();
  let queue: Promise<unknown> = Promise.resolve();
  let lastOutcome: LastSendOutcome = { status: "never" };
  const loaded = bb.storage.kv.get(LAST_OUTCOME_KEY).then((stored) => {
    const parsed = lastSendOutcomeSchema.safeParse(stored);
    if (parsed.success) lastOutcome = parsed.data;
  });

  function serial<T>(run: () => Promise<T>): Promise<T> {
    const result = queue.then(run, run);
    queue = result.catch(() => undefined);
    return result;
  }

  async function readAll(): Promise<PushSubscription[]> {
    const rows: PushSubscription[] = [];
    for (const key of await bb.storage.kv.list(PREFIX)) {
      const parsed = pushSubscriptionSchema.safeParse(
        await bb.storage.kv.get(key),
      );
      if (parsed.success) rows.push(parsed.data);
      else bb.log.warn(`Ignored invalid push subscription row ${key}`);
    }
    return rows.sort(
      (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
    );
  }

  const mine = async (userId: string | null) =>
    (await serial(readAll)).filter((row) => row.userId === userId);

  function publish(message: Omit<ClientNotification, "id">): void {
    notification.set({ id: randomUUID(), ...message });
  }

  bb.implement(pushNotifications.test, async ({ channel }) => {
    const config = await settings.get();
    if (!(channel === "web" ? config.webEnabled : config.desktopEnabled)) {
      throw new OpError(
        "invalid_input",
        `${channel} notifications are disabled. Turn them on with \`bb plugin config push-notifications set ${channel}Enabled true\`.`,
      );
    }
    publish({
      title: "bb notifications are working",
      body: "You’ll be notified when a thread needs your attention.",
      threadId: null,
      channels: [channel],
    });
    return { ok: true as const };
  });

  bb.implement(pushNotifications.list, async (_input, { caller }) => ({
    subscriptions: (await mine(caller.user)).map(
      ({ expoPushToken, userId: _userId, ...row }) => ({
        ...row,
        tokenSuffix: expoPushToken.slice(-6),
      }),
    ),
  }));

  bb.implement(pushNotifications.create, (input, { caller }) =>
    serial(async () => {
      const at = bb.now();
      const existing = (await readAll()).find(
        (row) => row.expoPushToken === input.token,
      );
      const row: PushSubscription = existing
        ? {
            ...existing,
            userId: caller.user,
            platform: input.platform,
            deviceLabel: input.label,
            lastSeenAt: Math.max(at, existing.lastSeenAt),
          }
        : {
            id: randomUUID(),
            userId: caller.user,
            expoPushToken: input.token,
            platform: input.platform,
            deviceLabel: input.label,
            createdAt: at,
            lastSeenAt: at,
          };
      await bb.storage.kv.set(`${PREFIX}${row.id}`, row);
      bb.changed(pushNotifications.list);
      return { id: row.id, created: existing === undefined };
    }),
  );

  bb.implement(pushNotifications.delete, ({ subscriptionId }, { caller }) =>
    serial(async () => {
      const found = (await readAll()).find(
        (row) => row.id === subscriptionId && row.userId === caller.user,
      );
      if (!found) {
        throw new OpError(
          "invalid_input",
          `Push subscription not found: ${subscriptionId}. Run \`bb push-notifications list\` for the registered ids.`,
        );
      }
      await bb.storage.kv.delete(`${PREFIX}${subscriptionId}`);
      bb.changed(pushNotifications.list);
      return { id: subscriptionId, removed: true as const };
    }),
  );

  bb.implement(pushNotifications.status, async (_input, { caller }) => {
    await loaded;
    const config = await settings.get();
    return {
      enabled: true as const,
      subscriptionCount: (await mine(caller.user)).length,
      mobileEnabled: config.mobileEnabled,
      webEnabled: config.webEnabled,
      desktopEnabled: config.desktopEnabled,
      relayUrl: config.expoPushUrl,
      lastSendOutcome: lastOutcome,
    };
  });

  function schedule(threadId: string, kind: PushKind, body: string): void {
    const existing = pending.get(threadId);
    if (existing) {
      existing.bodies.set(kind, body);
      existing.eventAt = Math.max(existing.eventAt, bb.now());
      return;
    }
    const timer = setTimeout(() => {
      const entry = pending.get(threadId);
      pending.delete(threadId);
      if (!entry) return;
      flush(threadId, entry).catch((error: unknown) =>
        bb.log.error(
          `Push notification flush failed for thread ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }, COALESCE_MS);
    timer.unref?.();
    pending.set(threadId, {
      bodies: new Map([[kind, body]]),
      eventAt: bb.now(),
      timer,
    });
  }

  async function getThread(threadId: string): Promise<Thread | null> {
    try {
      return await bb.call(threads.get, { threadId });
    } catch {
      return null;
    }
  }

  async function resolve(
    thread: Thread,
    entry: Pending,
  ): Promise<{ kind: PushKind; body: string } | null> {
    let interaction: PendingInteraction | undefined;
    if (entry.bodies.has("pending-interaction")) {
      const listed = await bb.call(interactions.list, { threadId: thread.id });
      interaction = listed.find((row) => row.status === "pending");
    }
    const live: Record<PushKind, boolean> = {
      "pending-interaction": interaction !== undefined,
      "thread-error": thread.status === "error",
      "turn-finished": thread.status === "idle",
    };
    const kind = KIND_PRIORITY.find(
      (candidate) => entry.bodies.has(candidate) && live[candidate],
    );
    if (kind === undefined) return null;
    const body = interaction
      ? describePendingInteraction(interaction)
      : (entry.bodies.get(kind) ?? "");
    return { kind, body };
  }

  async function flush(threadId: string, entry: Pending): Promise<void> {
    const thread = await getThread(threadId);
    if (
      !thread ||
      thread.deletedAt !== null ||
      thread.archivedAt !== null ||
      thread.visibility !== "visible"
    ) {
      return;
    }
    const lastReadAt = thread.lastReadAt ?? 0;
    if (lastReadAt >= thread.latestAttentionAt && lastReadAt >= entry.eventAt) {
      return;
    }
    const resolved = await resolve(thread, entry);
    if (!resolved) return;
    const preview = await notificationPreviewText(resolved.body, async (id) => {
      const referenced = await getThread(id);
      return referenced ? threadDisplayTitle(referenced) : null;
    });
    const title = truncate(threadDisplayTitle(thread), 80);
    const body = truncate(preview || FALLBACK_BODIES[resolved.kind], 180);
    const config = await settings.get();
    const channels = (["web", "desktop"] as const).filter(
      (channel) => config[`${channel}Enabled`],
    );
    if (channels.length > 0) {
      publish({ title, body, threadId: thread.id, channels });
    }
    if (!config.mobileEnabled) return;
    const owner = thread.createdByUserId;
    const rows = (await serial(readAll)).filter(
      (row) => owner === null || row.userId === owner,
    );
    if (rows.length === 0) return;
    const serverUrl = bb.pick(server.publicUrl)?.() ?? null;
    const result = await deliver(
      {
        relay: fetchRelay,
        url: config.expoPushUrl,
        warn: (message) => bb.log.warn(message),
        unregistered: async (subscription) => {
          await serial(() => bb.storage.kv.delete(PREFIX + subscription.id));
          bb.log.info(`Removed unregistered push device ${subscription.id}`);
        },
      },
      rows.map((subscription) => ({
        subscription,
        message: {
          to: subscription.expoPushToken,
          title,
          body,
          data: {
            kind: resolved.kind,
            projectId: thread.projectId,
            ...(serverUrl === null ? {} : { serverUrl }),
            threadId: thread.id,
          },
          sound: "default",
          channelId: "threads",
          priority: "high",
        },
      })),
    );
    await loaded;
    lastOutcome =
      result.failure === null
        ? { status: "sent", at: bb.now(), sentCount: result.sentCount }
        : { status: "failed", at: bb.now(), reason: result.failure };
    await bb.storage.kv.set(LAST_OUTCOME_KEY, lastOutcome);
  }

  bb.on(interactions.pending, ({ thread, interaction }) =>
    schedule(
      thread.id,
      "pending-interaction",
      describePendingInteraction(interaction),
    ),
  );
  bb.on(threads.failed, ({ thread, error }) =>
    schedule(thread.id, "thread-error", errorLine(error)),
  );
  bb.on(threads.idle, ({ thread, lastAssistantText }) => {
    if (thread.parentThreadId !== null || thread.visibility !== "visible") {
      return;
    }
    schedule(thread.id, "turn-finished", lastAssistantText ?? "");
  });
  bb.onDispose(() => {
    for (const entry of pending.values()) clearTimeout(entry.timer);
    pending.clear();
  });
}
