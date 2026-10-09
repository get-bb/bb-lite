import {
  PluginCliError,
  cliCommand,
  defineCli,
  threads,
  type PluginServerApi,
} from "@bb/plugin";
import {
  promptInputSchema,
  providerErrorInfoSchema,
  providerRateLimitStateSchema,
} from "@bb/domain";
import { z } from "zod";
import {
  DEFAULT_MAXIMUM_WAIT_MS,
  decideRetry,
  type Failure,
} from "./policy.js";

const MAXIMUM_WAIT_MS: Record<string, number | null> = {
  "6 hours": DEFAULT_MAXIMUM_WAIT_MS,
  "24 hours": 24 * 60 * 60 * 1_000,
  "No limit": null,
};

const EVENT_TYPES = [
  "client/turn/requested",
  "provider/error",
  "provider/rateLimits/updated",
].join(",");

const requested = z.object({ input: z.array(promptInputSchema).min(1) });
const providerError = z.object({ errorInfo: providerErrorInfoSchema });
const rateLimitsUpdated = z.object({
  rateLimits: providerRateLimitStateSchema,
});

const pendingSchema = z.object({
  attempt: z.number().int(),
  queuedMessageId: z.string().nullable(),
});
type Pending = z.infer<typeof pendingSchema>;

interface QueuedRetry {
  id: string;
  threadId: string;
  sendAt: number | null;
}

const JSON_OPTION = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;

const THREAD_ID = {
  name: "thread-id",
  description: "Thread whose pending retry to act on; defaults to this thread",
} as const;

export default function providerRetry(bb: PluginServerApi): void {
  const settings = bb.settings.define({
    maximumWait: {
      type: "select",
      label: "Maximum automatic wait",
      description:
        "Do not schedule a subscription-limit retry when its reset is farther away than this.",
      options: Object.keys(MAXIMUM_WAIT_MS).map((value) => ({
        value,
        label: value,
      })),
      default: "6 hours",
    },
  });
  const { kv } = bb.storage;
  const key = (threadId: string) => `thread:${threadId}`;
  const pending = async (threadId: string): Promise<Pending | null> => {
    const parsed = pendingSchema.safeParse(await kv.get(key(threadId)));
    return parsed.success ? parsed.data : null;
  };

  const lastFailure = async (threadId: string, attemptNumber: number) => {
    const rows = await bb.call(threads.events, {
      threadId,
      order: "desc",
      limit: 100,
      types: EVENT_TYPES,
    });
    let category: Failure["category"] = null;
    let rateLimits: Failure["rateLimits"] = null;
    for (const row of rows) {
      if (row.type === "client/turn/requested") {
        const turn = requested.safeParse(row.data);
        if (!turn.success) return null;
        const failure = { attemptNumber, category, rateLimits };
        return { input: turn.data.input, failure };
      }
      if (row.type === "provider/error" && category === null) {
        category =
          providerError.safeParse(row.data).data?.errorInfo.category ?? null;
      }
      if (row.type === "provider/rateLimits/updated" && rateLimits === null) {
        rateLimits =
          rateLimitsUpdated.safeParse(row.data).data?.rateLimits ?? null;
      }
    }
    return null;
  };

  bb.on(threads.failed, async ({ thread }) => {
    const threadId = thread.id;
    const attempt = ((await pending(threadId))?.attempt ?? 0) + 1;
    const found = await lastFailure(threadId, attempt);
    const { maximumWait } = await settings.get();
    const decision =
      found === null
        ? null
        : decideRetry({
            failure: found.failure,
            maximumWaitMs:
              MAXIMUM_WAIT_MS[String(maximumWait)] ?? DEFAULT_MAXIMUM_WAIT_MS,
            now: bb.now(),
            random: Math.random(),
          });
    if (found === null || decision === null || decision.kind === "decline") {
      await kv.delete(key(threadId));
      return;
    }
    const sent = await bb.call(threads.send, {
      threadId,
      input: found.input,
      mode: "queue-if-active",
      sendAt: decision.sendAt,
    });
    const queuedMessageId =
      sent.delivery === "queued" ? sent.queuedMessage.id : null;
    await kv.set(key(threadId), { attempt, queuedMessageId });
    bb.log.info("Scheduled provider retry", {
      threadId,
      reason: decision.reason,
      sendAt: decision.sendAt,
    });
  });

  bb.on(threads.idle, ({ thread }) => kv.delete(key(thread.id)));

  const findRetry = async (threadId: string): Promise<QueuedRetry | null> => {
    const id = (await pending(threadId))?.queuedMessageId ?? null;
    if (id === null) return null;
    const rows = await bb.call(threads.listQueuedMessages, { threadId });
    const row = rows.find((candidate) => candidate.id === id);
    return row === undefined ? null : { id, threadId, sendAt: row.sendAt };
  };

  const listRetries = async (threadId: string | null) => {
    const ids =
      threadId === null
        ? (await kv.list("thread:")).map((entry) => entry.slice(7))
        : [threadId];
    const found = await Promise.all(ids.map(findRetry));
    return found.filter((row): row is QueuedRetry => row !== null);
  };

  const act = async (
    requestedId: string | undefined,
    context: { threadId?: string },
    json: boolean,
    command: "cancel" | "retry",
  ) => {
    const threadId = requestedId ?? context.threadId;
    if (threadId === undefined) {
      throw new PluginCliError(
        `A thread id is required: bb provider-retry ${command} <thread-id>`,
        { code: "missing_thread_id", exitCode: 2 },
      );
    }
    const queued = await findRetry(threadId);
    if (queued === null) {
      throw new PluginCliError(
        `No pending provider retry exists for ${threadId}.`,
        {
          code: "no_pending_retry",
          hint: "Run `bb provider-retry status` for the threads with a pending retry.",
        },
      );
    }
    const ref = { threadId, queuedMessageId: queued.id };
    if (command === "cancel") {
      await bb.call(threads.deleteQueuedMessage, ref);
      await kv.delete(key(threadId));
    } else {
      await bb.call(threads.sendQueuedMessage, { ...ref, mode: "auto" });
    }
    const done =
      command === "cancel"
        ? `Cancelled provider retry for ${threadId}.\n`
        : `Retrying ${threadId} now.\n`;
    const body = { ok: true, ...ref };
    const stdout = json ? `${JSON.stringify(body, null, 2)}\n` : done;
    return { exitCode: 0, stdout };
  };

  const describe = (row: QueuedRetry) => {
    const when =
      row.sendAt === null
        ? "pending"
        : `retrying ${new Date(row.sendAt).toISOString()}`;
    return `${row.threadId}\t${row.id}\t${when}`;
  };

  bb.cli.register(
    defineCli({
      name: "provider-retry",
      summary: "Manage pending automatic provider retries",
      commands: {
        status: cliCommand({
          summary: "Show pending automatic provider retries",
          positionals: [
            {
              name: "thread-id",
              description:
                "Thread to scope the listing to; defaults to this thread, and lists every thread outside one",
            },
          ],
          options: { json: JSON_OPTION },
          async run(input, context) {
            const threadId =
              input.positionals["thread-id"] ?? context.threadId ?? null;
            const retries = await listRetries(threadId);
            const stdout = input.options.json
              ? `${JSON.stringify({ retries }, null, 2)}\n`
              : retries.length === 0
                ? "No provider retries are pending.\n"
                : `${retries.map(describe).join("\n")}\n`;
            return { exitCode: 0, stdout };
          },
        }),
        cancel: cliCommand({
          summary: "Cancel a pending automatic provider retry",
          positionals: [THREAD_ID],
          options: { json: JSON_OPTION },
          run: (input, context) =>
            act(
              input.positionals["thread-id"],
              context,
              input.options.json,
              "cancel",
            ),
        }),
        retry: cliCommand({
          summary: "Send a pending provider retry now instead of waiting",
          positionals: [THREAD_ID],
          options: { json: JSON_OPTION },
          run: (input, context) =>
            act(
              input.positionals["thread-id"],
              context,
              input.options.json,
              "retry",
            ),
        }),
      },
    }),
  );
}
