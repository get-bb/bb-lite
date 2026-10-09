import { threads } from "@bb/plugin/app";
import type { ThreadResponse, UpdateThreadRequest } from "@bb/server-contract";
import {
  beginThreadUpdates,
  settleThreadUpdates,
} from "../hooks/mutations/thread-state-mutations";
import { appQueryClient } from "./app-query-client";
import { client } from "./client";

export type ThreadUpdate = UpdateThreadRequest & { threadId: string };

interface PendingThreadUpdate {
  update: ThreadUpdate;
  reject: (reason: unknown) => void;
  resolve: (thread: ThreadResponse) => void;
}

let pending: PendingThreadUpdate[] = [];

async function flush(): Promise<void> {
  const batch = pending;
  pending = [];
  const updates = batch.map(({ update }) => update);
  let snapshot;
  try {
    snapshot = await beginThreadUpdates(appQueryClient, updates);
  } catch (error) {
    for (const request of batch) request.reject(error);
    return;
  }
  const results = await Promise.allSettled(
    updates.map((update) => client.call(threads.update, update)),
  );
  const failed = results.some((result) => result.status === "rejected");
  settleThreadUpdates(
    appQueryClient,
    updates.map(({ threadId }) => threadId),
    failed ? snapshot : undefined,
  );
  results.forEach((result, index) => {
    if (result.status === "fulfilled") batch[index]?.resolve(result.value);
    else batch[index]?.reject(result.reason);
  });
}

export function updateThread(update: ThreadUpdate): Promise<ThreadResponse> {
  const { title, sectionId, parentThreadId } = update;
  const placement = [title, sectionId, parentThreadId];
  if (placement.every((field) => field === undefined)) {
    return client.call(threads.update, update);
  }
  return new Promise<ThreadResponse>((resolve, reject) => {
    if (pending.push({ update, reject, resolve }) === 1) {
      queueMicrotask(() => void flush());
    }
  });
}
