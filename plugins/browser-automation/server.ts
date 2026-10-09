import { randomUUID } from "node:crypto";
import {
  machines,
  sessions as agentSessions,
  threads,
  type PluginServerApi,
} from "@bb/plugin";
import { registerCli } from "./cli.js";
import {
  browserAutomation as ba,
  previewDirective,
  sessionSchema,
  type PreviewFrame,
  type Session,
} from "./contract.js";

export const TTL_MS = 30 * 60_000;
export const IDLE_TIMEOUT_MS = 5 * 60_000;
const PREVIEW_WAIT_MS = 5_000;
const MAX_SESSIONS = 64;
const PAGES_SCRIPT = "await browser.listPages()";
const shotScript = (page: string) =>
  `const page = await browser.getPage(${JSON.stringify(page)}); await page.shot({ type: "jpeg", maxEdge: 960, quality: 70 }); undefined`;

const INSTRUCTIONS =
  "When `bb browser-automation open` returns a previewDirective, copy it into your next response exactly once as a standalone line before you continue working. Do not wrap it in backticks or a code fence, and do not invent or edit the session ID. The directive shows the user a live view of that headless browser in BB chat. Desktop sessions return no directive.";

class CodedError extends Error {
  constructor(
    readonly cliCode: string,
    message: string,
  ) {
    super(message);
  }
}

interface Active {
  session: Session;
  lastUsed: number;
  busy: number;
}

export default function browserAutomationServer(bb: PluginServerApi): void {
  const active = new Map<string, Active>();
  const frames = new Map<string, PreviewFrame>();
  const waiters = new Set<() => void>();
  const key = (s: { threadId: string; id: string }) =>
    `sessions/${encodeURIComponent(s.threadId)}/${s.id}`;
  const save = (session: Session) => bb.storage.kv.set(key(session), session);

  async function owned(threadId: string, sessionId: string) {
    const found = active.get(sessionId)?.session;
    const stored =
      found ??
      sessionSchema
        .optional()
        .parse(await bb.storage.kv.get(key({ threadId, id: sessionId })));
    if (stored === undefined || stored.threadId !== threadId)
      throw new Error("Session does not belong to this thread");
    return stored;
  }

  async function usable(threadId: string, sessionId: string) {
    const session = await owned(threadId, sessionId);
    const entry = active.get(sessionId);
    if (
      entry === undefined ||
      session.state !== "ready" ||
      bb.now() >= session.expiresAt
    )
      throw new Error("Session stopped or expired; open a new session");
    return entry;
  }

  async function finish(entry: Active, state: "stopped" | "closed") {
    const { session } = entry;
    if (session.state === "closed") return session;
    active.delete(session.id);
    frames.delete(session.id);
    session.state = state;
    await save(session);
    await bb.runners
      .call(session.hostId, ba.hostClose, { sessionId: session.id })
      .catch(() =>
        bb.log.warn(
          `Browser Automation cleanup on host ${session.hostId} incomplete; host expiry and lease revocation remain active.`,
        ),
      );
    return session;
  }

  async function runOn(
    threadId: string,
    sessionId: string,
    script: string,
    timeoutMs: number,
  ) {
    const entry = await usable(threadId, sessionId);
    entry.busy += 1;
    try {
      const output = await bb.runners.call(entry.session.hostId, ba.hostRun, {
        sessionId,
        script,
        timeoutMs,
      });
      if (output.exitCode === 124) await finish(entry, "stopped");
      return output;
    } catch (error) {
      await finish(entry, "stopped");
      throw error;
    } finally {
      entry.busy -= 1;
      entry.lastUsed = bb.now();
    }
  }

  bb.implement(ba.open, async ({ threadId, selection }) => {
    await bb.call(threads.get, { threadId });
    if (selection.backend === "desktop")
      throw new CodedError(
        "desktop_unavailable",
        "The desktop backend is not available in this bb: it has no in-app desktop browser. Use --backend local --headless.",
      );
    if (active.size >= MAX_SESSIONS)
      throw new Error(
        "Browser session limit reached; close an existing session",
      );
    const now = bb.now();
    const session: Session = {
      id: randomUUID(),
      threadId,
      hostId: selection.hostId,
      backend: selection.backend,
      state: "ready",
      createdAt: now,
      expiresAt: now + TTL_MS,
    };
    const entry = { session, lastUsed: now, busy: 1 };
    active.set(session.id, entry);
    await save(session);
    try {
      for (;;) {
        const runtime = await bb.runners.call(
          session.hostId,
          ba.hostPrepare,
          {},
        );
        if (runtime.status === "ready") break;
        bb.log.info(
          `DevBrowser runtime on host ${session.hostId}: ${runtime.detail}`,
        );
      }
      await bb.runners.call(session.hostId, ba.hostOpen, {
        sessionId: session.id,
        expiresAt: session.expiresAt,
        idleTimeoutMs: IDLE_TIMEOUT_MS,
      });
    } catch (error) {
      await finish(entry, "closed");
      throw error;
    } finally {
      entry.busy -= 1;
    }
    return { ...session, previewDirective: previewDirective(session.id) };
  });

  bb.implement(ba.list, async ({ threadId }) => {
    const prefix = `sessions/${encodeURIComponent(threadId)}/`;
    const keys = await bb.storage.kv.list(prefix);
    const all = await Promise.all(
      keys.map(async (k) => sessionSchema.parse(await bb.storage.kv.get(k))),
    );
    return all.sort((a, b) => a.createdAt - b.createdAt).slice(-MAX_SESSIONS);
  });

  bb.implement(ba.run, (input) =>
    runOn(input.threadId, input.sessionId, input.script, input.timeoutMs),
  );
  bb.implement(ba.pages, (input) =>
    runOn(input.threadId, input.sessionId, PAGES_SCRIPT, 30_000),
  );
  bb.implement(ba.screenshot, (input) =>
    runOn(input.threadId, input.sessionId, shotScript(input.page), 30_000),
  );

  bb.on(ba.previewFrame, ({ sessionId, frame }) => {
    if (!active.has(sessionId)) return;
    frames.set(sessionId, frame);
    for (const wake of waiters) wake();
  });

  bb.implement(ba.preview, async (input, { signal }) => {
    const session = await owned(input.threadId, input.sessionId);
    const entry = active.get(session.id);
    if (
      entry === undefined ||
      session.backend !== "local" ||
      session.state !== "ready" ||
      bb.now() >= session.expiresAt
    )
      return { session, frame: null };
    await bb.runners.call(session.hostId, ba.hostPreview, {
      sessionId: session.id,
      size: input.size,
    });
    const fresh = () => {
      const frame = frames.get(session.id);
      return frame !== undefined &&
        (frame.sequence > input.afterSequence ||
          input.afterSequence > frame.sequence)
        ? frame
        : null;
    };
    const frame =
      fresh() ??
      (await new Promise<PreviewFrame | null>((resolve) => {
        const done = () => {
          waiters.delete(wake);
          clearTimeout(timer);
          resolve(fresh());
        };
        const wake = () => {
          if (fresh() !== null) done();
        };
        const timer = setTimeout(done, PREVIEW_WAIT_MS);
        waiters.add(wake);
        signal.addEventListener("abort", done, { once: true });
      }));
    return { session, frame };
  });

  const ending =
    (state: "stopped" | "closed") =>
    async (input: { threadId: string; sessionId: string }) => {
      const session = await owned(input.threadId, input.sessionId);
      const entry = active.get(session.id);
      if (entry !== undefined) return finish(entry, state);
      if (session.state === "ready") {
        session.state = state;
        await save(session);
      }
      return session;
    };
  bb.implement(ba.stop, ending("stopped"));
  bb.implement(ba.close, ending("closed"));

  const closeWhere = (match: (s: Session) => boolean) =>
    Promise.all(
      [...active.values()]
        .filter((entry) => match(entry.session))
        .map((entry) => finish(entry, "closed")),
    );

  bb.on(machines.disconnected, ({ hostId }) =>
    closeWhere((s) => s.hostId === hostId),
  );
  bb.on(threads.deleted, ({ thread }) =>
    closeWhere((s) => s.threadId === thread.id),
  );

  bb.on(agentSessions.instructions, async (_context, next) => [
    { source: bb.pluginId, text: INSTRUCTIONS },
    ...(await next()),
  ]);

  bb.onStart(() => {
    const timer = setInterval(() => {
      const now = bb.now();
      void closeWhere(
        (s) =>
          now >= s.expiresAt ||
          (active.get(s.id)?.busy === 0 &&
            now - (active.get(s.id)?.lastUsed ?? now) >= IDLE_TIMEOUT_MS),
      );
    }, 1_000);
    timer.unref();
    return () => {
      clearInterval(timer);
      void closeWhere(() => true);
    };
  });

  registerCli(bb);
}
