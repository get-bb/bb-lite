import { contract, live, op } from "@bb/plugin";
import { z } from "zod";

export const DEFAULT_EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_PUSH_TOKEN_MAX_LENGTH = 512;
export const DEVICE_LABEL_MAX_LENGTH = 120;

export const pushPlatformSchema = z.enum(["ios", "android"]);
export const clientChannelSchema = z.enum(["web", "desktop"]);
export type ClientChannel = z.infer<typeof clientChannelSchema>;

export const pushSubscriptionSchema = z.object({
  id: z.string().min(1),
  userId: z.string().nullable(),
  expoPushToken: z.string().min(1).max(EXPO_PUSH_TOKEN_MAX_LENGTH),
  platform: pushPlatformSchema,
  deviceLabel: z.string().min(1).max(DEVICE_LABEL_MAX_LENGTH),
  createdAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative(),
});
export type PushSubscription = z.infer<typeof pushSubscriptionSchema>;

export const pushSubscriptionSummarySchema = pushSubscriptionSchema
  .omit({ expoPushToken: true, userId: true })
  .extend({ tokenSuffix: z.string().max(6) });
export type PushSubscriptionSummary = z.infer<
  typeof pushSubscriptionSummarySchema
>;

export const lastSendOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("never") }),
  z.object({
    status: z.literal("sent"),
    at: z.number().int().nonnegative(),
    sentCount: z.number().int().nonnegative(),
  }),
  z.object({
    status: z.literal("failed"),
    at: z.number().int().nonnegative(),
    reason: z.string().min(1),
  }),
]);
export type LastSendOutcome = z.infer<typeof lastSendOutcomeSchema>;

export const clientNotificationSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  body: z.string(),
  threadId: z.string().nullable(),
  channels: z.array(clientChannelSchema),
});
export type ClientNotification = z.infer<typeof clientNotificationSchema>;

const statusSchema = z.object({
  enabled: z.literal(true),
  subscriptionCount: z.number(),
  mobileEnabled: z.boolean(),
  webEnabled: z.boolean(),
  desktopEnabled: z.boolean(),
  relayUrl: z.string(),
  lastSendOutcome: lastSendOutcomeSchema,
});

function formatOutcome(outcome: LastSendOutcome): string {
  if (outcome.status === "never") return "Never";
  const at = new Date(outcome.at).toISOString();
  if (outcome.status === "sent") return `Sent ${outcome.sentCount} at ${at}`;
  return `Failed at ${at}: ${outcome.reason}`;
}

export const pushNotifications = contract("pushNotifications", {
  test: op({
    input: z.object({
      channel: z
        .enum(clientChannelSchema.options, { error: "Use web or desktop" })
        .describe("Client type to notify"),
    }),
    output: z.object({ ok: z.literal(true) }),
    kind: "write",
    doors: {
      cli: {
        path: "push-notifications test",
        summary:
          "Send a test to connected web or desktop clients with permission",
        positionals: ["channel"],
        print: (_output, { channel }) =>
          `Test sent to connected ${channel} clients with notification permission`,
      },
    },
  }),
  list: op({
    input: z.object({}),
    output: z.object({ subscriptions: z.array(pushSubscriptionSummarySchema) }),
    doors: {
      cli: {
        path: "push-notifications list",
        summary: "List your registered push devices",
        print: ({ subscriptions }) =>
          subscriptions.length === 0
            ? "No push devices registered"
            : [
                "ID\tDevice\tPlatform\tLast seen\tToken suffix",
                ...subscriptions.map((row) =>
                  [
                    row.id,
                    row.deviceLabel,
                    row.platform,
                    new Date(row.lastSeenAt).toISOString(),
                    row.tokenSuffix,
                  ].join("\t"),
                ),
              ].join("\n"),
      },
    },
  }),
  create: op({
    input: z.object({
      token: z
        .string()
        .trim()
        .min(1)
        .max(EXPO_PUSH_TOKEN_MAX_LENGTH)
        .describe("Expo push token the device reported"),
      platform: pushPlatformSchema.describe("Device operating system"),
      label: z
        .string()
        .trim()
        .min(1)
        .max(DEVICE_LABEL_MAX_LENGTH)
        .describe("Name shown for the device"),
    }),
    output: z.object({ id: z.string(), created: z.boolean() }),
    kind: "write",
    secret: ["token"],
    doors: {
      cli: {
        path: "push-notifications add",
        summary: "Register or refresh an Expo push device",
        print: ({ id, created }) =>
          `${created ? "Registered" : "Refreshed"} push device ${id}`,
      },
    },
  }),
  delete: op({
    input: z.object({
      subscriptionId: z
        .string()
        .min(1)
        .describe("Subscription id, as `bb push-notifications list` prints it"),
    }),
    output: z.object({ id: z.string(), removed: z.literal(true) }),
    kind: "write",
    doors: {
      cli: {
        path: "push-notifications remove",
        summary: "Remove a registered push device",
        positionals: ["subscriptionId"],
        print: ({ id }) => `Removed push device ${id}`,
      },
    },
  }),
  status: op({
    input: z.object({}),
    output: statusSchema,
    doors: {
      cli: {
        path: "push-notifications status",
        summary: "Show push delivery status",
        print: (status) =>
          [
            `Enabled: ${status.enabled}`,
            `Mobile: ${status.mobileEnabled}`,
            `Web: ${status.webEnabled}`,
            `Desktop: ${status.desktopEnabled}`,
            `Subscriptions: ${status.subscriptionCount}`,
            `Relay URL: ${status.relayUrl}`,
            `Last send: ${formatOutcome(status.lastSendOutcome)}`,
          ].join("\n"),
      },
    },
  }),
  notification: live(clientNotificationSchema.nullable()),
});
