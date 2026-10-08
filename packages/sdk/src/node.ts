import { createBbSdk, type BbSdk } from "./core.js";
import {
  DEFAULT_BB_REQUEST_TIMEOUT_MS,
  type FetchImplementation,
} from "./http.js";

export interface CreateNodeBbSdkArgs {
  baseUrl?: string;
  fetch?: FetchImplementation;
  timeoutMs?: number;
}

const DEFAULT_BB_SERVER_URL = "http://127.0.0.1:48886";
export const THREAD_ID_HEADER = "x-bb-thread-id";
const DOOR_HEADER = "x-bb-door";

function onBehalfOfThread(send: FetchImplementation): FetchImplementation {
  const threadId = process.env.BB_THREAD_ID;
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set(DOOR_HEADER, "cli");
    if (threadId) headers.set(THREAD_ID_HEADER, threadId);
    return send(input, { ...init, headers });
  };
}

export function createNodeBbSdk(args: CreateNodeBbSdkArgs = {}): BbSdk {
  const timeoutMs = args.timeoutMs ?? DEFAULT_BB_REQUEST_TIMEOUT_MS;
  return createBbSdk({
    baseUrl: args.baseUrl ?? process.env.BB_SERVER_URL ?? DEFAULT_BB_SERVER_URL,
    fetch: onBehalfOfThread(args.fetch ?? fetch),
    ...(args.fetch === undefined ? { timeoutMs } : {}),
  });
}

export * from "./core.js";
export {
  ThreadWaitTimeoutError,
  ThreadWaitUnreachableError,
} from "./areas/threads.js";
