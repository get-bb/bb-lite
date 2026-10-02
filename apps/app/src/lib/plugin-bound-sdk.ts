import type {
  BbSdkAreas,
  ThreadForkArgs,
  ThreadMutationResult,
  ThreadSpawnArgs,
  ThreadUpdateArgs,
} from "@bb/sdk";
import type { QueryClient } from "@tanstack/react-query";
import {
  applyThreadMetadataBatchResult,
  beginThreadMetadataBatchTransaction,
  invalidateThreadMetadataBatch,
  rollbackThreadMetadataBatchTransaction,
} from "@/hooks/cache-owners/thread-state-cache-owner";
import { sdk } from "@/lib/sdk";

interface PendingThreadUpdate {
  args: ThreadUpdateArgs;
  reject: (reason: unknown) => void;
  resolve: (thread: ThreadMutationResult) => void;
}

function createThreadUpdateBatcher(queryClient: QueryClient) {
  let pending: PendingThreadUpdate[] = [];
  const flush = async () => {
    const batch = pending;
    pending = [];
    let transaction;
    try {
      transaction = await beginThreadMetadataBatchTransaction({
        queryClient,
        updates: batch.map(({ args }) => args),
      });
    } catch (error) {
      for (const request of batch) request.reject(error);
      return;
    }
    const results = await Promise.allSettled(
      batch.map(({ args }) => sdk.threads.update(args)),
    );
    const threads = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    if (threads.length === results.length) {
      applyThreadMetadataBatchResult({ queryClient, threads });
    } else {
      rollbackThreadMetadataBatchTransaction({ queryClient, transaction });
      invalidateThreadMetadataBatch({
        queryClient,
        threadIds: batch.map(({ args }) => args.threadId),
      });
    }
    results.forEach((result, index) => {
      if (result.status === "fulfilled") batch[index]?.resolve(result.value);
      else batch[index]?.reject(result.reason);
    });
  };
  return (args: ThreadUpdateArgs) => {
    const { title, sectionId, parentThreadId } = args;
    if (
      [title, sectionId, parentThreadId].every((field) => field === undefined)
    )
      return sdk.threads.update(args);
    return new Promise<ThreadMutationResult>((resolve, reject) => {
      if (pending.push({ args, reject, resolve }) === 1)
        queueMicrotask(() => void flush());
    });
  };
}

function attributed<Args extends ThreadForkArgs | ThreadSpawnArgs>(
  args: Args,
  pluginId: string,
): Args {
  if (args.pluginMetadata !== undefined)
    return { ...args, origin: "plugin", originPluginId: pluginId };
  if (args.origin !== undefined && args.origin !== "plugin") return args;
  const originPluginId = args.originPluginId ?? pluginId;
  return { ...args, origin: "plugin", originPluginId };
}

const boundSdks = new Map<string, BbSdkAreas>();

export function getPluginBoundSdk(
  pluginId: string,
  queryClient: QueryClient,
): BbSdkAreas {
  let bound = boundSdks.get(pluginId);
  if (bound === undefined) {
    bound = {
      ...sdk,
      threads: {
        ...sdk.threads,
        update: createThreadUpdateBatcher(queryClient),
        fork: (args) => sdk.threads.fork(attributed(args, pluginId)),
        spawn: (args) => sdk.threads.spawn(attributed(args, pluginId)),
      },
    };
    boundSdks.set(pluginId, bound);
  }
  return bound;
}
