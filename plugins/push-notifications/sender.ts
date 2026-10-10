import type { PendingInteraction, Thread } from "@bb/domain";
import { z } from "zod";
import type { PushSubscription } from "./contract.js";

export type PushKind = "pending-interaction" | "turn-finished" | "thread-error";

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data: {
    kind: PushKind;
    projectId: string;
    serverUrl?: string;
    threadId: string;
  };
  sound: "default";
  channelId: "threads";
  priority: "high";
}

export interface PushRelay {
  send(
    url: string,
    messages: readonly ExpoPushMessage[],
  ): Promise<{ status: number; text: string }>;
}

export const fetchRelay: PushRelay = {
  async send(url, messages) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(messages),
    });
    return { status: response.status, text: await response.text() };
  },
};

const BATCH_SIZE = 100;

const ticketSchema = z.union([
  z.object({ status: z.literal("ok") }),
  z.object({
    status: z.literal("error"),
    details: z.object({ error: z.string().optional() }).optional(),
  }),
]);
const responseSchema = z.object({
  data: z.array(ticketSchema).optional(),
  errors: z.array(z.object({ code: z.string().optional() })).optional(),
});

export interface Delivery {
  message: ExpoPushMessage;
  subscription: PushSubscription;
}

export interface RelayHooks {
  relay: PushRelay;
  url: string;
  warn(message: string): void;
  unregistered(subscription: PushSubscription): Promise<void>;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function sendBatch(
  hooks: RelayHooks,
  batch: readonly Delivery[],
): Promise<{ sentCount: number; failure: string | null }> {
  let reply: { status: number; text: string };
  try {
    reply = await hooks.relay.send(
      hooks.url,
      batch.map((delivery) => delivery.message),
    );
  } catch {
    hooks.warn(`Expo push request failed for ${batch.length} devices`);
    return { sentCount: 0, failure: "network request failed" };
  }
  const parsed = responseSchema.safeParse(parseJson(reply.text));
  if (!parsed.success) {
    hooks.warn(`Expo push response not understood (status ${reply.status})`);
    return { sentCount: 0, failure: "relay returned an invalid response" };
  }
  const { data, errors } = parsed.data;
  if (errors && errors.length > 0) {
    const codes = errors.map((error) => error.code ?? "unknown").join(", ");
    hooks.warn(`Expo push request was rejected with codes ${codes}`);
    return { sentCount: 0, failure: "relay rejected the request" };
  }
  if (data === undefined) {
    return { sentCount: 0, failure: "relay returned no tickets" };
  }
  let sentCount = 0;
  let rejected = false;
  for (const [index, ticket] of data.entries()) {
    const delivery = batch[index];
    if (!delivery) continue;
    if (ticket.status === "ok") {
      sentCount += 1;
      continue;
    }
    const code = ticket.details?.error ?? "unknown";
    if (code === "DeviceNotRegistered") {
      await hooks.unregistered(delivery.subscription);
      continue;
    }
    rejected = true;
    hooks.warn(`Expo push ticket reported ${code}`);
  }
  return {
    sentCount,
    failure: rejected ? "relay rejected one or more tickets" : null,
  };
}

export async function deliver(
  hooks: RelayHooks,
  deliveries: readonly Delivery[],
): Promise<{ sentCount: number; failure: string | null }> {
  let sentCount = 0;
  let failure: string | null = null;
  for (let index = 0; index < deliveries.length; index += BATCH_SIZE) {
    const result = await sendBatch(
      hooks,
      deliveries.slice(index, index + BATCH_SIZE),
    );
    sentCount += result.sentCount;
    failure ??= result.failure;
  }
  return { sentCount, failure };
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

export function errorLine(error: string | null): string {
  return firstLine(error ?? "");
}

export function threadDisplayTitle(thread: Thread): string {
  return (
    thread.title?.trim() ||
    thread.titleFallback?.trim() ||
    `Thread ${thread.id.slice(0, 8)}`
  );
}

export function describePendingInteraction(
  interaction: PendingInteraction,
): string {
  const payload = interaction.payload;
  if (payload.kind === "user_question") {
    return (
      firstLine(payload.questions[0]?.prompt ?? "") ||
      "The agent has a question for you"
    );
  }
  if (payload.kind === "approval") {
    const subject = payload.subject;
    if (subject.kind === "command") {
      return `Approve command: ${firstLine(subject.command)}`;
    }
    if (subject.kind === "file_change") return "Approve file changes";
    if (subject.kind === "permission_grant") {
      return subject.toolName
        ? `Grant permissions to ${subject.toolName}`
        : "Grant additional permissions";
    }
    return "Review the plan before the agent continues";
  }
  if ("title" in payload) return payload.title;
  return "Waiting for your input";
}
