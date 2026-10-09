import { z } from "zod";
import type { PreviewFrame, PreviewSize } from "./contract.js";

const messageSchema = z.object({
  id: z.number().int().optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
  sessionId: z.string().optional(),
});
const targetInfoSchema = z.object({
  targetId: z.string(),
  type: z.string(),
  url: z.string(),
  title: z.string(),
});
const frameSchema = z.object({
  data: z.string().min(1),
  sessionId: z.number().int(),
  metadata: z.object({
    deviceWidth: z.number().positive(),
    deviceHeight: z.number().positive(),
  }),
});

const EDGE: Record<PreviewSize, number> = { thumbnail: 800, full: 1280 };
const MAX_FRAME_CHARS = 700_000;
const OPEN = 1;

export interface PreviewSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "open" | "close" | "error",
    listener: () => void,
  ): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
}

export interface PreviewSource {
  request(size: PreviewSize, onFrame: (frame: PreviewFrame) => void): void;
  close(): void;
}

export interface PreviewTiming {
  ackMs: number;
  idleMs: number;
  fullHoldMs: number;
}

export function createPreview(
  connectionUrl: string,
  openSocket: (url: string) => PreviewSocket = (url) => new WebSocket(url),
  timing: PreviewTiming = { ackMs: 250, idleMs: 15_000, fullHoldMs: 10_000 },
  now: () => number = Date.now,
): PreviewSource {
  const targets = new Map<string, { url: string; title: string; at: number }>();
  const calls = new Map<number, (message: { result?: unknown }) => void>();
  let socket: PreviewSocket | null = null;
  let cast: { targetId: string; sessionId: string; edge: number } | null = null;
  let listener: ((frame: PreviewFrame) => void) | null = null;
  let latest: PreviewFrame | null = null;
  let sequence = 0;
  let callId = 0;
  let clock = 0;
  let fullUntil = 0;
  let nextAckAt = 0;
  let selecting = Promise.resolve();
  let idle: NodeJS.Timeout | null = null;

  const send = (
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ) =>
    new Promise<unknown>((resolve, reject) => {
      if (socket === null || socket.readyState !== OPEN)
        return reject(new Error("Browser preview connection closed"));
      const id = ++callId;
      calls.set(id, (message) => resolve(message.result));
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const disconnect = () => {
    const current = socket;
    socket = null;
    cast = null;
    targets.clear();
    calls.clear();
    if (current !== null && current.readyState <= OPEN) current.close();
  };

  const select = () => {
    selecting = selecting
      .then(async () => {
        let best: { id: string; rank: number; at: number } | null = null;
        for (const [id, t] of targets) {
          const rank = t.url === "" || t.url === "about:blank" ? 0 : 1;
          if (
            !best ||
            rank > best.rank ||
            (rank === best.rank && t.at > best.at)
          )
            best = { id, rank, at: t.at };
        }
        const edge = now() < fullUntil ? EDGE.full : EDGE.thumbnail;
        const targetId = best?.id ?? null;
        if (
          targetId === (cast?.targetId ?? null) &&
          (cast === null || cast.edge === edge)
        )
          return;
        let sessionId: string;
        if (cast !== null && cast.targetId === targetId) {
          sessionId = cast.sessionId;
          await send("Page.stopScreencast", {}, sessionId);
        } else {
          const previous = cast;
          cast = null;
          if (previous !== null)
            await send("Target.detachFromTarget", {
              sessionId: previous.sessionId,
            }).catch(() => undefined);
          if (targetId === null) return;
          sessionId = z
            .object({ sessionId: z.string() })
            .parse(
              await send("Target.attachToTarget", { targetId, flatten: true }),
            ).sessionId;
        }
        cast = { targetId, sessionId, edge };
        await send(
          "Page.startScreencast",
          { format: "jpeg", quality: 60, maxWidth: edge, maxHeight: edge },
          sessionId,
        );
      })
      .catch(disconnect);
  };

  const publish = (frame: PreviewFrame) => {
    latest = frame;
    listener?.(frame);
  };

  const receive = (raw: string) => {
    const message = messageSchema.parse(JSON.parse(raw));
    if (message.id !== undefined) {
      const call = calls.get(message.id);
      calls.delete(message.id);
      if (message.error === undefined) call?.(message);
      else disconnect();
      return;
    }
    const { method, params } = message;
    if (
      method === "Target.targetCreated" ||
      method === "Target.targetInfoChanged"
    ) {
      const info = z
        .object({ targetInfo: targetInfoSchema })
        .parse(params).targetInfo;
      if (info.type !== "page") return;
      const known = targets.get(info.targetId);
      targets.set(info.targetId, {
        url: info.url,
        title: info.title,
        at: known?.url === info.url ? known.at : ++clock,
      });
      if (latest !== null && cast?.targetId === info.targetId)
        publish({
          ...latest,
          sequence: ++sequence,
          url: info.url.slice(0, 2_000),
          title: info.title.slice(0, 300),
        });
      select();
    } else if (method === "Target.targetDestroyed") {
      const { targetId } = z.object({ targetId: z.string() }).parse(params);
      targets.delete(targetId);
      if (cast?.targetId === targetId) cast = null;
      select();
    } else if (method === "Page.screencastFrame") {
      if (cast === null || message.sessionId !== cast.sessionId) return;
      const frame = frameSchema.parse(params);
      const target = targets.get(cast.targetId);
      if (frame.data.length <= MAX_FRAME_CHARS)
        publish({
          sequence: ++sequence,
          mimeType: "image/jpeg",
          data: frame.data,
          width: frame.metadata.deviceWidth,
          height: frame.metadata.deviceHeight,
          url: (target?.url ?? "").slice(0, 2_000),
          title: (target?.title ?? "").slice(0, 300),
        });
      const sessionId = cast.sessionId;
      const wait = Math.max(0, nextAckAt - now());
      nextAckAt = now() + wait + timing.ackMs;
      setTimeout(() => {
        if (cast?.sessionId === sessionId)
          void send(
            "Page.screencastFrameAck",
            { sessionId: frame.sessionId },
            sessionId,
          ).catch(() => undefined);
      }, wait).unref();
    }
  };

  const connect = () => {
    const current = openSocket(connectionUrl);
    socket = current;
    current.addEventListener("open", () => {
      if (socket !== current) return;
      void send("Target.setDiscoverTargets", { discover: true }).catch(
        disconnect,
      );
    });
    current.addEventListener("message", ({ data }) => {
      if (socket !== current || typeof data !== "string") return;
      try {
        receive(data);
      } catch {
        disconnect();
      }
    });
    current.addEventListener("close", () => {
      if (socket === current) disconnect();
    });
    current.addEventListener("error", () => {
      if (socket === current) disconnect();
    });
  };

  return {
    request(size, onFrame) {
      listener = onFrame;
      if (size === "full") fullUntil = now() + timing.fullHoldMs;
      if (idle !== null) clearTimeout(idle);
      idle = setTimeout(() => {
        listener = null;
        disconnect();
      }, timing.idleMs);
      idle.unref();
      if (socket === null) connect();
      else select();
      if (latest !== null) onFrame(latest);
    },
    close() {
      if (idle !== null) clearTimeout(idle);
      listener = null;
      disconnect();
    },
  };
}
