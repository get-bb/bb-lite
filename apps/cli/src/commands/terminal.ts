import type { TerminalCreateScope, TerminalListScope } from "@bb/sdk";
import type { TerminalSession } from "@bb/server-contract";
import {
  durationMs,
  integer,
  machineFlag,
  readStdin,
  type Call,
} from "../call.js";
import { CliError, usageError, type Run } from "../engine.js";

interface OutputChunk {
  dataBase64: string;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const INPUT_CHUNK_BYTES = 64 * 1024;
const MATCH_WINDOW_CHARS = 256 * 1024;
const EXIT_TAIL_CHARS = 2000;
const UNMATCHED_EXIT_CODE = 124;

async function listScope(c: Call): Promise<TerminalListScope> {
  const threadId = c.id("thread");
  const environmentId = c.id("environment");
  const hostId = await machineFlag(c);
  const given = [threadId, environmentId, hostId].filter(Boolean).length;
  if (given !== 1) {
    const current = c.env.threadId;
    const message =
      "Provide exactly one of --thread, --environment, --machine.";
    const hint =
      current === undefined
        ? null
        : `For this thread's terminals add --thread ${current}.`;
    const code = given === 0 ? "missing_required" : "invalid_value";
    throw new CliError(message, { code, hint });
  }
  if (threadId !== undefined) return { kind: "thread", threadId };
  if (environmentId !== undefined)
    return { kind: "environment", environmentId };
  return { kind: "host_path", hostId: hostId ?? "", cwd: c.flag("cwd") };
}

function describeExit(terminalId: string, exitCode: number | null): string {
  const code = exitCode === null ? "" : ` with code ${exitCode}`;
  return `Terminal ${terminalId} exited${code}`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function decode(chunks: readonly OutputChunk[]): Buffer {
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64")),
  );
}

function outputBounds(c: Call) {
  return {
    tailBytes: integer(c.flag("tail-bytes"), "--tail-bytes"),
    limitChunks: integer(c.flag("limit-chunks"), "--limit-chunks"),
  };
}

export const terminalCreate: Run = async (c) => {
  const typed = c.flag("command")?.trim();
  if (typed !== undefined && c.rest.length > 0) {
    throw usageError("Provide --command or positional words, not both.");
  }
  const command = typed ?? c.rest.map(shellQuote).join(" ");
  const scope = await listScope(c);
  const target: TerminalCreateScope =
    scope.kind === "host_path" ? { ...scope, cwd: scope.cwd ?? null } : scope;
  const session = await c.sdk.terminals.create({
    scope: target,
    cols: integer(c.flag("cols"), "--cols") ?? DEFAULT_COLS,
    rows: integer(c.flag("rows"), "--rows") ?? DEFAULT_ROWS,
    title: c.flag("title"),
    start: command === "" ? { mode: "shell" } : { mode: "command", command },
  });
  c.out(session, `Created terminal ${session.id} (${session.title})`);
};

export const terminalList: Run = async (c) => {
  const result = await c.sdk.terminals.list({ scope: await listScope(c) });
  c.rows(result.sessions, ["id", "title", "status", "exitCode"], result);
};

export const terminalOutput: Run = async (c) => {
  const terminalId = c.arg("terminalId");
  const sinceSeq = integer(c.flag("since-seq"), "--since-seq", 0);
  const query = { terminalId, sinceSeq, ...outputBounds(c) };
  const result = await c.sdk.terminals.output(query);
  if (c.json) return c.out(result);
  process.stdout.write(decode(result.chunks));
  if (result.status === "exited") {
    console.error(describeExit(terminalId, result.exitCode));
  }
};

function unmatched(message: string, hint: string, code = "terminal_exited") {
  return new CliError(message, { code, hint, exitCode: UNMATCHED_EXIT_CODE });
}

export const terminalWait: Run = async (c) => {
  const terminalId = c.arg("terminalId");
  const contains = c.flag("contains");
  const pattern = c.flag("regex");
  const untilExit = c.on("exit");
  const targets = [contains !== undefined, pattern !== undefined, untilExit];
  if (targets.filter(Boolean).length !== 1) {
    const message = "Provide exactly one of --contains, --regex or --exit.";
    const hint = `For example: bb terminal wait ${terminalId} --exit`;
    throw new CliError(message, { code: "missing_required", hint });
  }
  const timeout = durationMs(c.flag("timeout") ?? "30", "--timeout", "s");
  const interval = c.flag("poll-interval") ?? "500";
  const pollMs = durationMs(interval, "--poll-interval", "ms");
  const regex = pattern === undefined ? null : new RegExp(pattern, "u");
  const bounds = outputBounds(c);
  const { terminals } = c.sdk;
  const deadline = Date.now() + timeout;
  const done = (matched: string, nextSeq: number, exitCode: number | null) => {
    const text =
      matched === "exit"
        ? describeExit(terminalId, exitCode)
        : `Terminal ${terminalId} matched ${matched}`;
    c.out({ terminalId, matched, nextSeq, exitCode }, text);
  };
  let nextSeq = c.on("from-start") ? 0 : undefined;
  if (!untilExit && nextSeq === undefined) {
    const tail = { terminalId, limitChunks: 1, tailBytes: 1 };
    const current = await terminals.output(tail);
    if (current.status === "exited") {
      const exited = describeExit(terminalId, current.exitCode);
      const hint = "Match its existing output with --from-start.";
      throw unmatched(`${exited} before this wait.`, hint);
    }
    nextSeq = current.nextSeq;
  }
  for (let seen = ""; Date.now() <= deadline;) {
    if (untilExit) {
      const session = await terminals.get({ terminalId });
      if (session.status === "exited") return done("exit", 0, session.exitCode);
    } else {
      const page = { terminalId, ...bounds, sinceSeq: nextSeq };
      const result = await terminals.output(page);
      nextSeq = result.nextSeq;
      const searched = seen + decode(result.chunks).toString("utf8");
      seen = searched.slice(-MATCH_WINDOW_CHARS);
      const found = regex?.test(searched) ? pattern : undefined;
      const matched =
        contains && searched.includes(contains) ? contains : found;
      if (matched !== undefined) return done(matched, nextSeq, result.exitCode);
      if (result.status === "exited") {
        const tail = seen.slice(-EXIT_TAIL_CHARS).trimEnd();
        const exited = describeExit(terminalId, result.exitCode);
        const hint =
          tail === "" ? "It printed nothing." : `Last output:\n${tail}`;
        throw unmatched(`${exited} before the output matched.`, hint);
      }
    }
    await new Promise((wake) => setTimeout(wake, pollMs));
  }
  const hint = `Read it with \`bb terminal output ${terminalId}\`.`;
  const message = `Timed out waiting for terminal ${terminalId}`;
  throw unmatched(message, hint, "timeout");
};

export const terminalSend: Run = async (c) => {
  const terminalId = c.arg("terminalId");
  const text = c.flag("text");
  if ((text === undefined) === !c.on("stdin")) {
    throw usageError("Provide exactly one of --text or --stdin.");
  }
  const body = text === undefined ? await readStdin() : Buffer.from(text);
  const data = Buffer.concat([body, Buffer.from(c.on("enter") ? "\n" : "")]);
  if (data.byteLength === 0)
    throw usageError("Terminal input cannot be empty.");
  let session: TerminalSession | undefined;
  for (let at = 0; at < data.byteLength; at += INPUT_CHUNK_BYTES) {
    const part = data.subarray(at, at + INPUT_CHUNK_BYTES);
    const dataBase64 = part.toString("base64");
    session = await c.sdk.terminals.input({ terminalId, dataBase64 });
  }
  c.out(session, `Sent input to terminal ${terminalId}`);
};

export const terminalClose: Run = async (c) => {
  const terminalId = c.arg("terminalId");
  const mode = c.on("if-clean") ? "if-clean" : "force";
  const session = await c.sdk.terminals.close({ terminalId, mode });
  c.out(session, `Closed terminal ${terminalId}`);
};
