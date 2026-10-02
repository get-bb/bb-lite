import { createBbSdk, type BbSdk, type BbSdkAreas } from "./core.js";
import { createNodeWebsocketFactory } from "./node-websocket.js";
import {
  createRequestTimeoutFetch,
  DEFAULT_BB_REQUEST_TIMEOUT_MS,
  type FetchImplementation,
} from "./response.js";
import { createHttpTransport } from "./transport-http.js";
import type {
  BbRealtimeSocketFactory,
  BbSdkContext,
  BbSdkTransport,
} from "./transport.js";

export interface CreateNodeTransportArgs {
  baseUrl?: string;
  fetch?: FetchImplementation;
  realtimeUrl?: string;
  timeoutMs?: number;
  websocket?: BbRealtimeSocketFactory;
}

export interface CreateNodeBbSdkArgs extends CreateNodeTransportArgs {
  context?: BbSdkContext;
}

const DEFAULT_BB_SERVER_URL = "http://127.0.0.1:48886";

export function createNodeTransport(
  args: CreateNodeTransportArgs = {},
): BbSdkTransport {
  return createHttpTransport({
    baseUrl: args.baseUrl ?? process.env.BB_SERVER_URL ?? DEFAULT_BB_SERVER_URL,
    fetch:
      args.fetch ??
      createRequestTimeoutFetch({
        timeoutMs: args.timeoutMs ?? DEFAULT_BB_REQUEST_TIMEOUT_MS,
      }),
    realtimeUrl: args.realtimeUrl,
    runtime: "node",
    websocket: args.websocket ?? createNodeWebsocketFactory(),
  });
}

export function createNodeBbSdk(args: CreateNodeBbSdkArgs = {}): BbSdk {
  return createBbSdk({
    context: args.context,
    transport: createNodeTransport(args),
  });
}

export {
  createBbSdk,
  createHttpTransport,
  createRequestTimeoutFetch,
  DEFAULT_BB_REQUEST_TIMEOUT_MS,
};
export { BbHttpError, BbRequestTimeoutError } from "./response.js";
export {
  DEFAULT_THREAD_WAIT_POLL_INTERVAL_MS,
  DEFAULT_THREAD_WAIT_TIMEOUT_MS,
  ThreadWaitTimeoutError,
  ThreadWaitUnreachableError,
} from "./areas/threads.js";
export type {
  BbSdk,
  BbSdkAreas,
  BbSdkContext,
  BbSdkTransport,
  FetchImplementation,
};
export type {
  BbRealtimeSocket,
  BbRealtimeSocketFactory,
  BbRealtimeSocketMessageEvent,
} from "./transport.js";
export type { BbHttpErrorArgs } from "./response.js";
export type * from "./public-types.js";
