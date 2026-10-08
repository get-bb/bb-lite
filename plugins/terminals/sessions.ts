import { terminals as terminalEvents } from "@bb/plugin";
import type { TerminalSessionCloseReason } from "@bb/domain";
import { RunnerError, TERMINAL_REPLAY_MAX_BYTES } from "@bb/runner";
import * as contract from "@bb/server-contract";
import type { WebSocket } from "ws";
import type { Disposer, ServerContext } from "@bb/server-kit/context";
import {
  getTerminal,
  insertTerminal,
  selectTerminals,
  updateTerminal,
} from "@bb/server-kit/db/terminals";
import type { RowValues } from "@bb/server-kit/db/index";
import { requireThread } from "@bb/server-kit/db/threads";
import {
  requireEnvironment,
  requireReadyEnvironment,
  requireThreadEnvironment,
} from "@bb/server-kit/environments/workspace";
import { ApiError, errorMessage, toApiError } from "@bb/server-kit/http/errors";
import { resolveContributedEnvironment } from "@bb/server-kit/machine-environment";
import { requireHost } from "@bb/server-kit/runners/hosts";
import { parseFrame } from "@bb/server-kit/ws/hub";

interface Client {
  send(message: contract.TerminalServerMessage): void;
  fail(code: string, message: string): void;
  nextSeq: number;
  replaying: boolean;
  backlog: contract.TerminalOutputChunk[];
}

interface Live {
  clients: Map<string, Set<Client>>;
  resizeOwners: Map<string, Client>;
}

const OUTPUT_READ_MAX_BYTES = 4 * 1024 * 1024;
const HOME_CWD = "~";
const POLICY_VIOLATION_CLOSE_CODE = 1008;
const OPEN_ON_RUNNER = "status IN ('starting', 'running')";
const liveByContext = new WeakMap<ServerContext, Live>();

function liveOf(ctx: ServerContext) {
  const live = liveByContext.get(ctx) ?? {
    clients: new Map<string, Set<Client>>(),
    resizeOwners: new Map<string, Client>(),
  };
  liveByContext.set(ctx, live);
  return live;
}

function clientsOf(ctx: ServerContext, terminalId: string) {
  return [...(liveOf(ctx).clients.get(terminalId) ?? [])];
}

function errorFrame(error: unknown): { code: string; message: string } {
  const message = errorMessage(error);
  return toApiError(error)?.body ?? { code: "terminal_socket_error", message };
}

function announce(ctx: ServerContext, session: contract.TerminalSession) {
  if (session.threadId !== null) {
    ctx.hub.thread(session.threadId, ["terminals-changed"]);
  }
  const type = session.status === "exited" ? "exited" : "session-updated";
  for (const client of clientsOf(ctx, session.id)) {
    client.send({ type, session });
  }
  return session;
}

export function changeTerminal(
  ctx: ServerContext,
  session: contract.TerminalSession,
  patch: RowValues,
): contract.TerminalSession {
  const current = getTerminal(ctx.db, session.id) ?? session;
  if (current.status === "exited" && "status" in patch) return current;
  const changed = updateTerminal(ctx.db, session.id, patch);
  return changed === undefined ? session : announce(ctx, changed);
}

function finish(
  ctx: ServerContext,
  session: contract.TerminalSession,
  closeReason: TerminalSessionCloseReason,
  exitCode: number | null = null,
): contract.TerminalSession {
  const exited = { status: "exited", closeReason, exitCode };
  return changeTerminal(ctx, session, exited);
}

function endTerminal(
  ctx: ServerContext,
  session: contract.TerminalSession,
  closeReason: TerminalSessionCloseReason,
): contract.TerminalSession {
  const { hostId, id: terminalId } = session;
  if (session.status !== "exited" && ctx.runners.isConnected(hostId)) {
    const closing = ctx.runners.get(hostId).closeTerminal({ terminalId });
    closing.catch(() => undefined);
  }
  return finish(ctx, session, closeReason);
}

function deliver(client: Client, chunk: contract.TerminalOutputChunk) {
  if (chunk.seq < client.nextSeq) return;
  client.nextSeq = chunk.seq + 1;
  client.send({ type: "output", chunk });
}

async function replay(
  ctx: ServerContext,
  session: contract.TerminalSession,
  client: Client,
  greeting: boolean,
) {
  const { id: terminalId, hostId } = session;
  const tailBytes = TERMINAL_REPLAY_MAX_BYTES;
  client.replaying = true;
  try {
    const runner = ctx.runners.get(hostId);
    const sinceSeq = client.nextSeq;
    const page = await runner.attachTerminal({
      terminalId,
      sinceSeq,
      tailBytes,
    });
    const { replayStartSeq, nextSeq } = page;
    const current = getTerminal(ctx.db, terminalId) ?? session;
    const attached = { type: "attached", session: current } as const;
    if (greeting) client.send({ ...attached, replayStartSeq, nextSeq });
    client.replaying = false;
    for (const chunk of [...page.chunks, ...client.backlog.splice(0)]) {
      deliver(client, chunk);
    }
  } catch (error) {
    client.replaying = false;
    const { code, message } = errorFrame(error);
    const lost = error instanceof RunnerError && code === "terminal_not_found";
    if (lost) finish(ctx, session, "daemon-disconnect");
    client.fail(code, message);
  }
}

function resume(ctx: ServerContext, session: contract.TerminalSession) {
  for (const client of clientsOf(ctx, session.id)) {
    void replay(ctx, session, client, false);
  }
}

async function reconcile(ctx: ServerContext, hostId: string) {
  const { db, runners } = ctx;
  const lost = "host_id = ? AND status = 'disconnected'";
  const stale = selectTerminals(db, lost, hostId);
  if (stale.length === 0 || !runners.isConnected(hostId)) return;
  const snapshot = await runners
    .get(hostId)
    .snapshot()
    .catch(() => null);
  if (snapshot === null) return;
  for (const session of stale) {
    if (snapshot.terminalIds.includes(session.id)) {
      resume(ctx, changeTerminal(ctx, session, { status: "running" }));
    } else {
      finish(ctx, session, "daemon-disconnect");
    }
  }
}

export function startTerminalSessions(ctx: ServerContext): Disposer {
  const { db, runners, log } = ctx;
  const reattach = (hostId: string) => {
    reconcile(ctx, hostId).catch((error: unknown) => {
      log.warn("Terminal reconciliation failed", { err: error, hostId });
    });
  };
  db.run(
    `UPDATE terminal_sessions SET status = 'disconnected'
     WHERE ${OPEN_ON_RUNNER}`,
  );
  const stops = [
    runners.onEvent("terminal.output", ({ terminalId, seq, dataBase64 }) => {
      const chunk = { seq, dataBase64 };
      for (const client of clientsOf(ctx, terminalId)) {
        if (client.replaying) client.backlog.push(chunk);
        else deliver(client, chunk);
      }
    }),
    runners.onEvent("terminal.exited", ({ terminalId, exitCode }, hostId) => {
      const session = getTerminal(db, terminalId);
      if (session?.hostId !== hostId) return;
      finish(ctx, session, "process-exit", exitCode);
    }),
    runners.onDisconnected((hostId) => {
      const open = `host_id = ? AND ${OPEN_ON_RUNNER}`;
      for (const session of selectTerminals(db, open, hostId)) {
        changeTerminal(ctx, session, { status: "disconnected" });
      }
    }),
    runners.onConnected(reattach),
  ];
  reattach(ctx.config.hostId);
  return () => stops.forEach((stop) => stop());
}

export function requireTerminal(
  ctx: ServerContext,
  terminalId: string,
): contract.TerminalSession {
  const session = getTerminal(ctx.db, terminalId);
  if (session === undefined) {
    throw new ApiError(404, "terminal_not_found", "Terminal session not found");
  }
  return session;
}

function notRunning() {
  const message = "Terminal session is not running";
  return new ApiError(409, "terminal_not_running", message);
}

export function requireRunning(ctx: ServerContext, terminalId: string) {
  const session = requireTerminal(ctx, terminalId);
  if (session.status === "running") return session;
  throw notRunning();
}

export function listTerminalSessions(
  ctx: ServerContext,
  query: contract.TerminalListQuery,
): contract.TerminalSession[] {
  const { db } = ctx;
  const { threadId, environmentId, hostId = "", cwd = null } = query;
  const open = "status <> 'exited'";
  if (threadId !== undefined) {
    requireThread(db, threadId);
    return selectTerminals(db, `thread_id = ? AND ${open}`, threadId);
  }
  const unowned = `thread_id IS NULL AND ${open}`;
  if (environmentId !== undefined) {
    const { id } = requireEnvironment(ctx, environmentId);
    return selectTerminals(db, `environment_id = ? AND ${unowned}`, id);
  }
  const { id } = requireHost(ctx, hostId);
  const onHost = `host_id = ? AND environment_id IS NULL AND ${unowned}
    AND (? IS NULL OR initial_cwd = ?)`;
  return selectTerminals(db, onHost, id, cwd, cwd);
}

function launchTarget(
  ctx: ServerContext,
  target: contract.TerminalCreateTarget,
) {
  if (target.kind === "host_path") {
    const { id: hostId } = requireHost(ctx, target.hostId);
    const unowned = { threadId: null, environmentId: null, projectId: null };
    return { ...unowned, hostId, cwd: target.cwd };
  }
  const threadId = target.kind === "thread" ? target.threadId : null;
  const environment = requireReadyEnvironment(
    ctx,
    target.kind === "thread"
      ? requireThreadEnvironment(ctx, target.threadId).id
      : target.environmentId,
  );
  const { id: environmentId, hostId, projectId, path: cwd } = environment;
  return { threadId, environmentId, hostId, projectId, cwd };
}

export async function createTerminal(
  ctx: ServerContext,
  payload: contract.CreateTerminalRequest,
): Promise<contract.TerminalSession> {
  const { projectId, cwd, ...owner } = launchTarget(ctx, payload.target);
  const runner = ctx.runners.get(owner.hostId);
  const { cols, rows, start = { mode: "shell" } } = payload;
  const title = payload.title ?? "Terminal";
  const initialCwd = cwd ?? HOME_CWD;
  const size = { cols, rows };
  const starting = announce(
    ctx,
    insertTerminal(ctx.db, { ...owner, ...size, title, initialCwd }),
  );
  const terminalId = starting.id;
  try {
    const env = await resolveContributedEnvironment(ctx, projectId);
    const launch = { terminalId, cwd, ...size, start, env };
    const opened = await runner.openTerminal(launch);
    const current = requireTerminal(ctx, terminalId);
    if (current.status !== "starting") {
      runner.closeTerminal({ terminalId }).catch(() => undefined);
      return current;
    }
    const running = changeTerminal(ctx, current, {
      status: "running",
      cols: opened.cols,
      rows: opened.rows,
      initialCwd: opened.initialCwd,
      title: payload.title ?? opened.title,
    });
    resume(ctx, running);
    return running;
  } catch (error) {
    finish(ctx, starting, "process-exit");
    throw error;
  }
}

export function closeTerminal(
  ctx: ServerContext,
  terminalId: string,
  request: contract.CloseTerminalRequest,
): contract.TerminalSession {
  const session = requireTerminal(ctx, terminalId);
  const dirty = session.lastUserInputAt !== null;
  if (request.mode === "if-clean" && dirty) return session;
  return endTerminal(ctx, session, request.reason);
}

export function closeTerminalsFor(
  ctx: ServerContext,
  owner: "thread_id" | "environment_id",
  ownerId: string,
  closeReason: TerminalSessionCloseReason,
): void {
  const open = `${owner} = ? AND status <> 'exited'`;
  for (const session of selectTerminals(ctx.db, open, ownerId)) {
    endTerminal(ctx, session, closeReason);
  }
}

export async function writeTerminalInput(
  ctx: ServerContext,
  session: contract.TerminalSession,
  dataBase64: string,
): Promise<contract.TerminalSession> {
  const { id: terminalId, hostId } = session;
  const marked =
    session.lastUserInputAt === null
      ? changeTerminal(ctx, session, { lastUserInputAt: ctx.now() })
      : session;
  await ctx.runners.get(hostId).writeTerminal({ terminalId, dataBase64 });
  const { threadId } = session;
  ctx.kernel.emit(terminalEvents.input, { terminalId, hostId, threadId });
  return marked;
}

export async function resizeTerminal(
  ctx: ServerContext,
  session: contract.TerminalSession,
  { cols, rows }: contract.TerminalResizeRequest,
): Promise<contract.TerminalSession> {
  const { id: terminalId, hostId } = session;
  const same = session.cols === cols && session.rows === rows;
  const resized = same ? session : changeTerminal(ctx, session, { cols, rows });
  await ctx.runners.get(hostId).resizeTerminal({ terminalId, cols, rows });
  return resized;
}

export async function readTerminalOutput(
  ctx: ServerContext,
  terminalId: string,
  query: contract.TerminalOutputQuery,
): Promise<contract.TerminalOutputResponse> {
  const session = requireTerminal(ctx, terminalId);
  const { status, exitCode, closeReason, hostId } = session;
  const unavailable = (reason: string) =>
    new ApiError(409, "terminal_output_unavailable", reason);
  if (status !== "running" && status !== "exited") {
    throw unavailable("Terminal output can only be read once it has started");
  }
  if (!ctx.runners.isConnected(hostId)) {
    throw unavailable("The machine that ran this terminal is not connected");
  }
  const runner = ctx.runners.get(hostId);
  const sinceSeq = query.sinceSeq ?? 0;
  const tailBytes = query.tailBytes ?? OUTPUT_READ_MAX_BYTES;
  const chunks: contract.TerminalOutputChunk[] = [];
  let from = sinceSeq;
  let nextSeq = sinceSeq;
  do {
    const page = await runner
      .attachTerminal({ terminalId, sinceSeq: from, tailBytes })
      .catch((error: unknown) => {
        const gone = errorFrame(error).code === "terminal_not_found";
        if (!gone) throw error;
        throw unavailable("The machine no longer holds this terminal's output");
      });
    chunks.push(...page.chunks);
    nextSeq = page.nextSeq;
    from = (page.chunks.at(-1)?.seq ?? nextSeq - 1) + 1;
  } while (from < nextSeq);
  const kept = chunks.slice(-(query.limitChunks ?? chunks.length));
  const truncated = (kept[0]?.seq ?? nextSeq) > sinceSeq;
  return { chunks: kept, nextSeq, truncated, status, exitCode, closeReason };
}

function receive(
  ctx: ServerContext,
  terminalId: string,
  client: Client,
  raw: string,
) {
  const message = parseFrame(contract.terminalClientMessageSchema, raw);
  if (message === null) {
    client.fail("invalid_message", "Invalid terminal message");
    return;
  }
  if (message.type === "ping") {
    client.send({ type: "pong" });
    return;
  }
  const session = getTerminal(ctx.db, terminalId);
  if (session === undefined || session.status === "exited") {
    client.send({ type: "error", ...notRunning().body });
    return;
  }
  if (session.status !== "running") return;
  const owner = liveOf(ctx).resizeOwners.get(terminalId) === client;
  if (message.type === "resize" && !owner) return;
  const work =
    message.type === "input"
      ? writeTerminalInput(ctx, session, message.dataBase64)
      : resizeTerminal(ctx, session, message);
  work.catch((error: unknown) => {
    client.send({ type: "error", ...errorFrame(error) });
  });
}

export function attachTerminalSocket(
  ctx: ServerContext,
  terminalId: string,
  sinceSeq: number,
  socket: WebSocket,
): void {
  const send = (message: contract.TerminalServerMessage) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };
  const fail = (code: string, message: string) => {
    send({ type: "error", code, message });
    socket.close(POLICY_VIOLATION_CLOSE_CODE, code);
  };
  const session = getTerminal(ctx.db, terminalId);
  if (session === undefined) {
    fail("terminal_not_found", "Terminal session not found");
    return;
  }
  const state = { nextSeq: sinceSeq, replaying: false, backlog: [] };
  const client: Client = { send, fail, ...state };
  const { clients, resizeOwners } = liveOf(ctx);
  const attached = clients.get(terminalId) ?? new Set<Client>();
  clients.set(terminalId, attached.add(client));
  resizeOwners.set(terminalId, client);
  const detach = () => {
    attached.delete(client);
    const emptied = attached.size === 0 && clients.get(terminalId) === attached;
    if (emptied) clients.delete(terminalId);
    if (resizeOwners.get(terminalId) !== client) return;
    const [heir] = attached;
    if (heir === undefined) resizeOwners.delete(terminalId);
    else resizeOwners.set(terminalId, heir);
  };
  socket.on("close", detach);
  socket.on("error", detach);
  socket.on("message", (data) => {
    receive(ctx, terminalId, client, data.toString());
  });
  if (session.status === "running") {
    void replay(ctx, session, client, true);
    return;
  }
  const held = session.status === "exited" ? 0 : sinceSeq;
  send({ type: "attached", session, replayStartSeq: held, nextSeq: held });
  if (session.status === "exited") send({ type: "exited", session });
}
