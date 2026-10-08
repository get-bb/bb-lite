import type { PluginServerApi } from "@bb/plugin";
import { terminals as terminalEvents } from "@bb/plugin";
import type { TerminalSessionCloseReason } from "@bb/domain";
import { RunnerError, TERMINAL_REPLAY_MAX_BYTES } from "@bb/runner";
import * as contract from "@bb/server-contract";
import type { WebSocket } from "ws";
import type { Disposer } from "@bb/server-kit/context";
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
const liveByContext = new WeakMap<PluginServerApi, Live>();

function liveOf(bb: PluginServerApi) {
  const live = liveByContext.get(bb) ?? {
    clients: new Map<string, Set<Client>>(),
    resizeOwners: new Map<string, Client>(),
  };
  liveByContext.set(bb, live);
  return live;
}

function clientsOf(bb: PluginServerApi, terminalId: string) {
  return [...(liveOf(bb).clients.get(terminalId) ?? [])];
}

function errorFrame(error: unknown): { code: string; message: string } {
  const message = errorMessage(error);
  return toApiError(error)?.body ?? { code: "terminal_socket_error", message };
}

function announce(bb: PluginServerApi, session: contract.TerminalSession) {
  if (session.threadId !== null) {
    bb.realtime.thread(session.threadId, ["terminals-changed"]);
  }
  const type = session.status === "exited" ? "exited" : "session-updated";
  for (const client of clientsOf(bb, session.id)) {
    client.send({ type, session });
  }
  return session;
}

export function changeTerminal(
  bb: PluginServerApi,
  session: contract.TerminalSession,
  patch: RowValues,
): contract.TerminalSession {
  const current = getTerminal(bb.db, session.id) ?? session;
  if (current.status === "exited" && "status" in patch) return current;
  const changed = updateTerminal(bb.db, session.id, patch);
  return changed === undefined ? session : announce(bb, changed);
}

function finish(
  bb: PluginServerApi,
  session: contract.TerminalSession,
  closeReason: TerminalSessionCloseReason,
  exitCode: number | null = null,
): contract.TerminalSession {
  const exited = { status: "exited", closeReason, exitCode };
  return changeTerminal(bb, session, exited);
}

function endTerminal(
  bb: PluginServerApi,
  session: contract.TerminalSession,
  closeReason: TerminalSessionCloseReason,
): contract.TerminalSession {
  const { hostId, id: terminalId } = session;
  if (session.status !== "exited" && bb.runners.isConnected(hostId)) {
    const closing = bb.runners.get(hostId).closeTerminal({ terminalId });
    closing.catch(() => undefined);
  }
  return finish(bb, session, closeReason);
}

function deliver(client: Client, chunk: contract.TerminalOutputChunk) {
  if (chunk.seq < client.nextSeq) return;
  client.nextSeq = chunk.seq + 1;
  client.send({ type: "output", chunk });
}

async function replay(
  bb: PluginServerApi,
  session: contract.TerminalSession,
  client: Client,
  greeting: boolean,
) {
  const { id: terminalId, hostId } = session;
  const tailBytes = TERMINAL_REPLAY_MAX_BYTES;
  client.replaying = true;
  try {
    const runner = bb.runners.get(hostId);
    const sinceSeq = client.nextSeq;
    const page = await runner.attachTerminal({
      terminalId,
      sinceSeq,
      tailBytes,
    });
    const { replayStartSeq, nextSeq } = page;
    const current = getTerminal(bb.db, terminalId) ?? session;
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
    if (lost) finish(bb, session, "daemon-disconnect");
    client.fail(code, message);
  }
}

function resume(bb: PluginServerApi, session: contract.TerminalSession) {
  for (const client of clientsOf(bb, session.id)) {
    void replay(bb, session, client, false);
  }
}

async function reconcile(bb: PluginServerApi, hostId: string) {
  const { db, runners } = bb;
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
      resume(bb, changeTerminal(bb, session, { status: "running" }));
    } else {
      finish(bb, session, "daemon-disconnect");
    }
  }
}

export function startTerminalSessions(bb: PluginServerApi): Disposer {
  const { db, runners, log } = bb;
  const reattach = (hostId: string) => {
    reconcile(bb, hostId).catch((error: unknown) => {
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
      for (const client of clientsOf(bb, terminalId)) {
        if (client.replaying) client.backlog.push(chunk);
        else deliver(client, chunk);
      }
    }),
    runners.onEvent("terminal.exited", ({ terminalId, exitCode }, hostId) => {
      const session = getTerminal(db, terminalId);
      if (session?.hostId !== hostId) return;
      finish(bb, session, "process-exit", exitCode);
    }),
    runners.onDisconnected((hostId) => {
      const open = `host_id = ? AND ${OPEN_ON_RUNNER}`;
      for (const session of selectTerminals(db, open, hostId)) {
        changeTerminal(bb, session, { status: "disconnected" });
      }
    }),
    runners.onConnected(reattach),
  ];
  reattach(bb.config.hostId);
  return () => stops.forEach((stop) => stop());
}

export function requireTerminal(
  bb: PluginServerApi,
  terminalId: string,
): contract.TerminalSession {
  const session = getTerminal(bb.db, terminalId);
  if (session === undefined) {
    throw new ApiError(404, "terminal_not_found", "Terminal session not found");
  }
  return session;
}

function notRunning() {
  const message = "Terminal session is not running";
  return new ApiError(409, "terminal_not_running", message);
}

export function requireRunning(bb: PluginServerApi, terminalId: string) {
  const session = requireTerminal(bb, terminalId);
  if (session.status === "running") return session;
  throw notRunning();
}

export function listTerminalSessions(
  bb: PluginServerApi,
  query: contract.TerminalListQuery,
): contract.TerminalSession[] {
  const { db } = bb;
  const { threadId, environmentId, hostId = "", cwd = null } = query;
  const open = "status <> 'exited'";
  if (threadId !== undefined) {
    requireThread(db, threadId);
    return selectTerminals(db, `thread_id = ? AND ${open}`, threadId);
  }
  const unowned = `thread_id IS NULL AND ${open}`;
  if (environmentId !== undefined) {
    const { id } = requireEnvironment(bb, environmentId);
    return selectTerminals(db, `environment_id = ? AND ${unowned}`, id);
  }
  const { id } = requireHost(bb, hostId);
  const onHost = `host_id = ? AND environment_id IS NULL AND ${unowned}
    AND (? IS NULL OR initial_cwd = ?)`;
  return selectTerminals(db, onHost, id, cwd, cwd);
}

function launchTarget(
  bb: PluginServerApi,
  target: contract.TerminalCreateTarget,
) {
  if (target.kind === "host_path") {
    const { id: hostId } = requireHost(bb, target.hostId);
    const unowned = { threadId: null, environmentId: null, projectId: null };
    return { ...unowned, hostId, cwd: target.cwd };
  }
  const threadId = target.kind === "thread" ? target.threadId : null;
  const environment = requireReadyEnvironment(
    bb,
    target.kind === "thread"
      ? requireThreadEnvironment(bb, target.threadId).id
      : target.environmentId,
  );
  const { id: environmentId, hostId, projectId, path: cwd } = environment;
  return { threadId, environmentId, hostId, projectId, cwd };
}

export async function createTerminal(
  bb: PluginServerApi,
  payload: contract.CreateTerminalRequest,
): Promise<contract.TerminalSession> {
  const { projectId, cwd, ...owner } = launchTarget(bb, payload.target);
  const runner = bb.runners.get(owner.hostId);
  const { cols, rows, start = { mode: "shell" } } = payload;
  const title = payload.title ?? "Terminal";
  const initialCwd = cwd ?? HOME_CWD;
  const size = { cols, rows };
  const starting = announce(
    bb,
    insertTerminal(bb.db, { ...owner, ...size, title, initialCwd }),
  );
  const terminalId = starting.id;
  try {
    const env = await resolveContributedEnvironment(bb, projectId);
    const launch = { terminalId, cwd, ...size, start, env };
    const opened = await runner.openTerminal(launch);
    const current = requireTerminal(bb, terminalId);
    if (current.status !== "starting") {
      runner.closeTerminal({ terminalId }).catch(() => undefined);
      return current;
    }
    const running = changeTerminal(bb, current, {
      status: "running",
      cols: opened.cols,
      rows: opened.rows,
      initialCwd: opened.initialCwd,
      title: payload.title ?? opened.title,
    });
    resume(bb, running);
    return running;
  } catch (error) {
    finish(bb, starting, "process-exit");
    throw error;
  }
}

export function closeTerminal(
  bb: PluginServerApi,
  terminalId: string,
  request: contract.CloseTerminalRequest,
): contract.TerminalSession {
  const session = requireTerminal(bb, terminalId);
  const dirty = session.lastUserInputAt !== null;
  if (request.mode === "if-clean" && dirty) return session;
  return endTerminal(bb, session, request.reason);
}

export function closeTerminalsFor(
  bb: PluginServerApi,
  owner: "thread_id" | "environment_id",
  ownerId: string,
  closeReason: TerminalSessionCloseReason,
): void {
  const open = `${owner} = ? AND status <> 'exited'`;
  for (const session of selectTerminals(bb.db, open, ownerId)) {
    endTerminal(bb, session, closeReason);
  }
}

export async function writeTerminalInput(
  bb: PluginServerApi,
  session: contract.TerminalSession,
  dataBase64: string,
): Promise<contract.TerminalSession> {
  const { id: terminalId, hostId } = session;
  const marked =
    session.lastUserInputAt === null
      ? changeTerminal(bb, session, { lastUserInputAt: bb.now() })
      : session;
  await bb.runners.get(hostId).writeTerminal({ terminalId, dataBase64 });
  const { threadId } = session;
  bb.emit(terminalEvents.input, { terminalId, hostId, threadId });
  return marked;
}

export async function resizeTerminal(
  bb: PluginServerApi,
  session: contract.TerminalSession,
  { cols, rows }: contract.TerminalResizeRequest,
): Promise<contract.TerminalSession> {
  const { id: terminalId, hostId } = session;
  const same = session.cols === cols && session.rows === rows;
  const resized = same ? session : changeTerminal(bb, session, { cols, rows });
  await bb.runners.get(hostId).resizeTerminal({ terminalId, cols, rows });
  return resized;
}

export async function readTerminalOutput(
  bb: PluginServerApi,
  terminalId: string,
  query: contract.TerminalOutputQuery,
): Promise<contract.TerminalOutputResponse> {
  const session = requireTerminal(bb, terminalId);
  const { status, exitCode, closeReason, hostId } = session;
  const unavailable = (reason: string) =>
    new ApiError(409, "terminal_output_unavailable", reason);
  if (status !== "running" && status !== "exited") {
    throw unavailable("Terminal output can only be read once it has started");
  }
  if (!bb.runners.isConnected(hostId)) {
    throw unavailable("The machine that ran this terminal is not connected");
  }
  const runner = bb.runners.get(hostId);
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
  bb: PluginServerApi,
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
  const session = getTerminal(bb.db, terminalId);
  if (session === undefined || session.status === "exited") {
    client.send({ type: "error", ...notRunning().body });
    return;
  }
  if (session.status !== "running") return;
  const owner = liveOf(bb).resizeOwners.get(terminalId) === client;
  if (message.type === "resize" && !owner) return;
  const work =
    message.type === "input"
      ? writeTerminalInput(bb, session, message.dataBase64)
      : resizeTerminal(bb, session, message);
  work.catch((error: unknown) => {
    client.send({ type: "error", ...errorFrame(error) });
  });
}

export function attachTerminalSocket(
  bb: PluginServerApi,
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
  const session = getTerminal(bb.db, terminalId);
  if (session === undefined) {
    fail("terminal_not_found", "Terminal session not found");
    return;
  }
  const state = { nextSeq: sinceSeq, replaying: false, backlog: [] };
  const client: Client = { send, fail, ...state };
  const { clients, resizeOwners } = liveOf(bb);
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
    receive(bb, terminalId, client, data.toString());
  });
  if (session.status === "running") {
    void replay(bb, session, client, true);
    return;
  }
  const held = session.status === "exited" ? 0 : sinceSeq;
  send({ type: "attached", session, replayStartSeq: held, nextSeq: held });
  if (session.status === "exited") send({ type: "exited", session });
}
