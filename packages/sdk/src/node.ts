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

export function createNodeBbSdk(args: CreateNodeBbSdkArgs = {}): BbSdk {
  const timeoutMs = args.timeoutMs ?? DEFAULT_BB_REQUEST_TIMEOUT_MS;
  return createBbSdk({
    baseUrl: args.baseUrl ?? process.env.BB_SERVER_URL ?? DEFAULT_BB_SERVER_URL,
    fetch: args.fetch ?? fetch,
    ...(args.fetch === undefined ? { timeoutMs } : {}),
  });
}

export * from "./core.js";
export {
  ThreadWaitTimeoutError,
  ThreadWaitUnreachableError,
} from "./areas/threads.js";
