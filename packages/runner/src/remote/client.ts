import type { WebSocket } from "ws";
import { opCaller, type Runner } from "../local.js";
import { RunnerError, type RunnerEventSink } from "../types.js";
import { linkFrames } from "./link.js";
import {
  RUNNER_METHODS,
  connectionLost,
  fromWireError,
  requestTimeoutMs,
  type Hello,
  type RunnerMethod,
} from "./protocol.js";

export interface RemoteRunner {
  runner: Runner;
  hello: Promise<Hello>;
  closed: Promise<void>;
  welcome(lastSeq: number): void;
}

interface PendingRequest {
  resolve(result: unknown): void;
  reject(error: RunnerError): void;
  timer: NodeJS.Timeout;
}

export function connectRemoteRunner(
  socket: WebSocket,
  sink: RunnerEventSink,
): RemoteRunner {
  const pending = new Map<number, PendingRequest>();
  let greet: (hello: Hello) => void = () => {};
  let markClosed: () => void = () => {};
  const hello = new Promise<Hello>((resolve) => (greet = resolve));
  const closed = new Promise<void>((resolve) => (markClosed = resolve));
  let lastRequestId = 0;
  let lost = false;

  const link = linkFrames(socket, {
    pings: true,
    onFrame: (frame) => {
      if (frame.t === "evt") return sink(frame.event);
      if (frame.t === "hello") return greet(frame);
      if (frame.t !== "res") return;
      const request = pending.get(frame.id);
      if (request === undefined) return;
      pending.delete(frame.id);
      clearTimeout(request.timer);
      if (frame.ok) request.resolve(frame.result);
      else request.reject(fromWireError(frame.error));
    },
    onClosed: () => {
      lost = true;
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(connectionLost());
      }
      pending.clear();
      markClosed();
    },
  });

  const call = (method: RunnerMethod, params: unknown) => {
    if (lost) return Promise.reject(connectionLost());
    lastRequestId += 1;
    const id = lastRequestId;
    const timeoutMs = requestTimeoutMs(method, params);
    return new Promise<unknown>((resolve, reject) => {
      const expire = () => {
        pending.delete(id);
        const message = `Runner did not answer ${method} in ${timeoutMs} ms`;
        reject(new RunnerError("unavailable", message, true));
      };
      const timer = setTimeout(expire, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      link.send({ t: "req", id, method, params });
    });
  };

  const methods = RUNNER_METHODS.map((method) => {
    return [method, (params: unknown) => call(method, params)] as const;
  });
  const runner = {
    ...Object.fromEntries(methods),
    ackEvents: async ({ seq }) => link.send({ t: "ack", seq }),
    call: opCaller((args) => call("callOp", args)),
  } as Runner;

  return {
    runner,
    hello,
    closed,
    welcome: (lastSeq) => link.send({ t: "welcome", lastSeq }),
  };
}
