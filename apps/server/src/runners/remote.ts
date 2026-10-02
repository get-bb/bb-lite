import {
  REPLACED_CLOSE_CODE,
  connectRemoteRunner,
  type Hello,
  type RunnerEventSink,
} from "@bb/runner";
import type { WebSocket } from "ws";
import type { ServerContext, ServerRunner } from "../context.js";
import { advanceHostEventCursor, findHost, updateHost } from "../db/hosts.js";

interface EventStream {
  instanceId: string;
  deliveredSeq: number;
}

const INTERNAL_ERROR_CLOSE_CODE = 1011;
const LAST_SEEN_INTERVAL_MS = 30_000;
const streams = new WeakMap<ServerContext, Map<string, EventStream>>();

function resumeStream(
  ctx: ServerContext,
  hostId: string,
  hello: Hello,
): EventStream {
  const byHost = streams.get(ctx) ?? new Map<string, EventStream>();
  streams.set(ctx, byHost);
  const { instanceId } = hello;
  const live = byHost.get(hostId);
  if (live?.instanceId === instanceId) return live;
  const stored = findHost(ctx.db, "id", hostId);
  if (stored === undefined) throw new Error("Host was removed");
  const known = stored.lastInstanceId === instanceId;
  const deliveredSeq = known ? stored.lastEventSeq : (hello.lastAckedSeq ?? 0);
  if (!known) {
    const cursor = { lastInstanceId: instanceId, lastEventSeq: deliveredSeq };
    updateHost(ctx.db, hostId, cursor);
  }
  const stream = { instanceId, deliveredSeq };
  byHost.set(hostId, stream);
  return stream;
}

export function attachRemoteRunner(
  ctx: ServerContext,
  hostId: string,
  socket: WebSocket,
): void {
  const { db, log, runners } = ctx;
  let deliver: RunnerEventSink = () => {};
  let seenAt = 0;
  const remote = connectRemoteRunner(socket, (event) => deliver(event));

  socket.on("message", () => {
    if (ctx.now() - seenAt < LAST_SEEN_INTERVAL_MS) return;
    seenAt = ctx.now();
    updateHost(db, hostId, { lastSeenAt: seenAt });
  });

  const connect = async (): Promise<void> => {
    const hello = await Promise.race([remote.hello, remote.closed]);
    if (hello === undefined) return;
    const { platform, threadStorageRoot } = await remote.runner.describe();
    const stream = resumeStream(ctx, hostId, hello);
    updateHost(db, hostId, { platform, threadStorageRoot });
    const runner: ServerRunner = {
      ...remote.runner,
      ackEvents: async ({ seq }) => {
        advanceHostEventCursor(db, hostId, stream.instanceId, seq);
        await remote.runner.ackEvents({ seq });
      },
    };
    let offDisconnected = (): void => {};
    const release = (): void => {
      offDisconnected();
      runners.disconnect(hostId, runner);
    };
    remote.closed.then(release).catch((error: unknown) => {
      log.error("Remote runner disconnect failed", { err: error, hostId });
    });
    runners.connect(hostId, (sink) => {
      deliver = (event) => {
        if (event.lane === "reliable") {
          if (event.seq <= stream.deliveredSeq) return;
          stream.deliveredSeq = event.seq;
        }
        sink(event);
      };
      return runner;
    });
    offDisconnected = runners.onDisconnected((disconnectedHostId) => {
      if (disconnectedHostId !== hostId) return;
      deliver = () => {};
      socket.close(REPLACED_CLOSE_CODE, "replaced or removed");
    });
    const { instanceId, version } = hello;
    log.info("Remote runner connected", { hostId, instanceId, version });
    remote.welcome(stream.deliveredSeq);
  };

  connect().catch((error: unknown) => {
    log.warn("Remote runner handshake failed", { err: error, hostId });
    socket.close(INTERNAL_ERROR_CLOSE_CODE, "runner handshake failed");
  });
}
