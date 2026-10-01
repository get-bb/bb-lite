import type { WebSocket } from "ws";
import type { LocalRunner } from "../local.js";
import {
  RunnerError,
  type RunnerEvent,
  type RunnerEventSink,
} from "../types.js";
import { linkFrames, type PayloadFrame } from "./link.js";
import { isRunnerMethod, toWireError, type WholeFrame } from "./protocol.js";

export const LIVE_HIGH_WATER_BYTES = 1024 * 1024;
export const LIVE_OUTPUT_KEEP_NEWEST = 32;

export interface RunnerServing {
  deliver: RunnerEventSink;
}

type Request = Extract<PayloadFrame, { t: "req" }>;

export function serveRunner(
  runner: LocalRunner,
  socket: WebSocket,
): RunnerServing {
  const held: { frame: WholeFrame; terminalOutput: boolean }[] = [];
  let welcomed = false;

  const pump = () => {
    while (socket.bufferedAmount <= LIVE_HIGH_WATER_BYTES) {
      const next = held.shift();
      if (next === undefined) return;
      link.send(next.frame, pump);
    }
  };

  const send = (frame: WholeFrame) => link.send(frame, pump);

  const holdLive = (event: RunnerEvent) => {
    const terminalOutput = event.kind === "terminal.output";
    held.push({ frame: { t: "evt", event }, terminalOutput });
    const outputs = held.filter((entry) => entry.terminalOutput);
    const [oldest] = outputs;
    if (oldest !== undefined && outputs.length > LIVE_OUTPUT_KEEP_NEWEST) {
      held.splice(held.indexOf(oldest), 1);
    }
    pump();
  };

  const answer = async ({ id, method, params }: Request) => {
    try {
      if (!isRunnerMethod(method)) {
        const message = `Runner method "${method}" cannot be called remotely`;
        throw new RunnerError("failed", message);
      }
      const call = runner[method] as (args: unknown) => Promise<unknown>;
      const result = await call(params);
      runner.outbox.flush();
      send({ t: "res", id, ok: true, result });
    } catch (error) {
      runner.outbox.flush();
      send({ t: "res", id, ok: false, error: toWireError(error) });
    }
  };

  const link = linkFrames(socket, {
    pings: false,
    onClosed: () => held.splice(0),
    onFrame: (frame) => {
      if (frame.t === "req") void answer(frame);
      else if (frame.t === "ack") runner.outbox.ack(frame.seq);
      else if (frame.t === "welcome") {
        welcomed = true;
        runner.outbox.resendAfter(frame.lastSeq);
      }
    },
  });

  const { lastAckedSeq } = runner.outbox;
  void runner.describe().then(({ instanceId, version }) => {
    send({ t: "hello", instanceId, version, lastAckedSeq });
  });

  return {
    deliver: (event) => {
      if (!welcomed) return;
      if (event.lane === "reliable") send({ t: "evt", event });
      else holdLive(event);
    },
  };
}
