import { API_VERSION, majorOf, type PluginServerApi } from "@bb/plugin";
import {
  OUTDATED_CLOSE_CODE,
  REPLACED_CLOSE_CODE,
  connectRemoteRunner,
  type Hello,
  type RunnerEventSink,
} from "@bb/runner";
import type { WebSocket } from "ws";
import type { ServerRunner } from "@bb/server-kit/context";
import {
  advanceHostEventCursor,
  findHost,
  updateHost,
} from "@bb/server-kit/db/hosts";

interface EventStream {
  instanceId: string;
  deliveredSeq: number;
}

const INTERNAL_ERROR_CLOSE_CODE = 1011;
const LAST_SEEN_INTERVAL_MS = 30_000;
const streams = new WeakMap<PluginServerApi, Map<string, EventStream>>();

function resumeStream(bb: PluginServerApi, hostId: string, hello: Hello) {
  const byHost = streams.get(bb) ?? new Map<string, EventStream>();
  streams.set(bb, byHost);
  const { instanceId } = hello;
  const live = byHost.get(hostId);
  if (live?.instanceId === instanceId) return live;
  const stored = findHost(bb.db, "id", hostId);
  if (stored === undefined) throw new Error("Host was removed");
  const known = stored.lastInstanceId === instanceId;
  const deliveredSeq = known ? stored.lastEventSeq : (hello.lastAckedSeq ?? 0);
  if (!known) {
    const cursor = { lastInstanceId: instanceId, lastEventSeq: deliveredSeq };
    updateHost(bb.db, hostId, cursor);
  }
  const stream = { instanceId, deliveredSeq };
  byHost.set(hostId, stream);
  return stream;
}

export function attachRemoteRunner(
  bb: PluginServerApi,
  hostId: string,
  socket: WebSocket,
): void {
  const { db, log, runners } = bb;
  let deliver: RunnerEventSink = () => {};
  let seenAt = 0;
  const remote = connectRemoteRunner(socket, (event) => deliver(event));

  socket.on("message", () => {
    if (bb.now() - seenAt < LAST_SEEN_INTERVAL_MS) return;
    seenAt = bb.now();
    updateHost(db, hostId, { lastSeenAt: seenAt });
  });

  const connect = async () => {
    const hello = await Promise.race([remote.hello, remote.closed]);
    if (hello === undefined) return;
    if (majorOf(hello.api ?? "0") !== majorOf(API_VERSION)) {
      const theirs = hello.api ?? "an older version";
      const statusMessage =
        `bb on this machine speaks plugin API ${theirs}; the server ` +
        `speaks ${API_VERSION}. Update bb there and restart its runner.`;
      updateHost(db, hostId, { statusMessage });
      log.warn("Remote runner refused", { hostId, api: theirs });
      socket.close(OUTDATED_CLOSE_CODE, "plugin API version mismatch");
      return;
    }
    const { platform, threadStorageRoot } = await remote.runner.describe();
    const stream = resumeStream(bb, hostId, hello);
    updateHost(db, hostId, {
      platform,
      threadStorageRoot,
      statusMessage: null,
    });
    const runner: ServerRunner = {
      ...remote.runner,
      ackEvents: async ({ seq }) => {
        advanceHostEventCursor(db, hostId, stream.instanceId, seq);
        await remote.runner.ackEvents({ seq });
      },
    };
    let offDisconnected = () => {};
    const release = () => {
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
