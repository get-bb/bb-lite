import type { PluginRunnerApi } from "@bb/runner";
import {
  browserAutomation as ba,
  type PreviewFrame,
  type PreviewSize,
  type RunOutput,
  type RuntimeState,
} from "./contract.js";
import { installRuntime, PIN } from "./installer.js";

export const MAX_HOST_SESSIONS = 32;
const PREPARE_POLL_MS = 20_000;
const GONE =
  "Session stopped, expired, or worker restarted; open a new session";

export interface BrowserSession {
  run(
    script: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<RunOutput>;
  preview?(size: PreviewSize, onFrame: (frame: PreviewFrame) => void): void;
  close(): Promise<void>;
}

export interface BrowserRuntime {
  prepare(signal: AbortSignal): Promise<{ version: string }>;
  open(sessionId: string, signal: AbortSignal): Promise<BrowserSession>;
}

interface Hosted {
  session: BrowserSession;
  queue: Promise<unknown>;
  expiresAt: number;
  idleTimeoutMs: number;
  lastUsed: number;
  active: number;
  abort: AbortController;
}

export function releaseRuntime(dataDir: string): BrowserRuntime {
  return {
    prepare: (signal) =>
      installRuntime({ dataDir, signal }).then(() => ({
        version: PIN.version,
      })),
    open: () =>
      Promise.reject(
        new Error(
          "The DevBrowser session launcher is not ported yet; this bb cannot start Chrome",
        ),
      ),
  };
}

export function createBrowserRunner(
  makeRuntime: (dataDir: string) => BrowserRuntime = releaseRuntime,
  now: () => number = Date.now,
) {
  return (bb: PluginRunnerApi): void => {
    const runtime = makeRuntime(bb.dataDir);
    const sessions = new Map<string, Hosted>();
    let install: Promise<{ version: string }> | null = null;

    const hosted = (sessionId: string) => {
      const found = sessions.get(sessionId);
      if (found === undefined) throw new Error(GONE);
      return found;
    };
    const close = async (sessionId: string) => {
      const found = sessions.get(sessionId);
      if (found === undefined) return;
      sessions.delete(sessionId);
      found.abort.abort();
      await found.session.close().catch(() => undefined);
    };

    bb.implement(ba.hostPrepare, async (): Promise<RuntimeState> => {
      install ??= runtime
        .prepare(AbortSignal.timeout(15 * 60_000))
        .catch((error: unknown) => {
          install = null;
          throw error;
        });
      const waiting = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), PREPARE_POLL_MS).unref(),
      );
      const ready = await Promise.race([install, waiting]);
      return ready === null
        ? { status: "installing", detail: "preparing the DevBrowser runtime" }
        : { status: "ready", version: ready.version, source: "release" };
    });

    bb.implement(
      ba.hostOpen,
      async ({ sessionId, expiresAt, idleTimeoutMs }) => {
        if (sessions.has(sessionId)) throw new Error("Session already exists");
        if (sessions.size >= MAX_HOST_SESSIONS)
          throw new Error("Host browser session limit reached");
        const abort = new AbortController();
        const session = await runtime.open(sessionId, abort.signal);
        sessions.set(sessionId, {
          session,
          queue: Promise.resolve(),
          expiresAt,
          idleTimeoutMs,
          lastUsed: now(),
          active: 0,
          abort,
        });
        return null;
      },
    );

    bb.implement(ba.hostRun, async ({ sessionId, script, timeoutMs }) => {
      const found = hosted(sessionId);
      found.active += 1;
      const signal = AbortSignal.any([
        found.abort.signal,
        AbortSignal.timeout(timeoutMs),
      ]);
      const result = found.queue.then(() =>
        found.session.run(script, timeoutMs, signal),
      );
      found.queue = result.catch(() => undefined);
      try {
        const output = await result;
        if (output.exitCode === 124) await close(sessionId);
        return output;
      } catch (error) {
        await close(sessionId);
        throw error;
      } finally {
        found.active -= 1;
        found.lastUsed = now();
      }
    });

    bb.implement(ba.hostPreview, ({ sessionId, size }) => {
      const found = hosted(sessionId);
      if (found.session.preview === undefined)
        throw new Error(
          "Live preview is available only for local headless sessions",
        );
      found.session.preview(size, (frame) =>
        bb.emit(ba.previewFrame, { sessionId, size, frame }),
      );
      return null;
    });

    bb.implement(ba.hostClose, async ({ sessionId }) => {
      await close(sessionId);
      return null;
    });

    const timer = setInterval(() => {
      const at = now();
      for (const [id, s] of sessions) {
        if (
          at >= s.expiresAt ||
          (s.active === 0 && at - s.lastUsed >= s.idleTimeoutMs)
        )
          void close(id);
      }
    }, 1_000);
    timer.unref();
    bb.onDispose(() => {
      clearInterval(timer);
      return Promise.all([...sessions.keys()].map(close)).then(() => undefined);
    });
  };
}

export default createBrowserRunner();
