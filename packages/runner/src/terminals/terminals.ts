import { constants } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { TerminalOutputChunk } from "@bb/server-contract";
import { spawn as spawnPty, type IPty } from "node-pty";
import {
  fail,
  pathExists,
  requireAbsolute,
  type Ctx,
} from "../workspace/exec.js";
import {
  TERMINAL_REPLAY_MAX_BYTES,
  type TerminalStart,
  type WorkspaceApi,
} from "../workspace-types.js";

const SCROLLBACK_MAX_BYTES = 4 * 1024 * 1024;
const SCROLLBACK_MAX_CHUNKS = 10_000;
const OUTPUT_CHUNK_MAX_BYTES = 64 * 1024;
const OUTPUT_BATCH_DELAY_MS = 4;
const CLOSE_GRACE_MS = 2_000;
const EXITED_RETENTION_MS = 30 * 60 * 1000;
const EXITED_MAX_TERMINALS = 32;
const EXITED_SCROLLBACK_MAX_BYTES = 512 * 1024;
const TITLE_MAX_LENGTH = 80;
const ESC = "\u001b";
const DEVICE_ATTRIBUTES_QUERY = new RegExp(`${ESC}\\[0?c`, "gu");
const DEVICE_ATTRIBUTES_PARTIALS = [`${ESC}[0`, `${ESC}[`, ESC];
const DEVICE_ATTRIBUTES_REPLY = `${ESC}[?1;2c`;
const DEVICE_ATTRIBUTES_MAX_REPLIES = 8;
const TERMINAL_ENV = {
  COLORTERM: "truecolor",
  DISABLE_AUTO_TITLE: "true",
  FORCE_HYPERLINK: "1",
  PROMPT_EOL_MARK: "",
  TERM: "xterm-256color",
};

class Terminal {
  nextSeq = 0;
  scrollback: { chunk: TerminalOutputChunk; byteLength: number }[] = [];
  scrollbackBytes = 0;
  pending: Buffer[] = [];
  flushTimer: NodeJS.Timeout | null = null;
  partialQuery = "";
  closeTimer: NodeJS.Timeout | null = null;
  exited: { exitCode: number | null } | null = null;
  constructor(
    readonly id: string,
    readonly pty: IPty,
    public cols: number,
    public rows: number,
  ) {}
}

export interface Terminals {
  open: WorkspaceApi["openTerminal"];
  attach: WorkspaceApi["attachTerminal"];
  write: WorkspaceApi["writeTerminal"];
  resize: WorkspaceApi["resizeTerminal"];
  close: WorkspaceApi["closeTerminal"];
  liveIds(): string[];
  dispose(): void;
}

async function resolveShell() {
  for (const shell of [process.env.SHELL, "/bin/zsh", "/bin/bash"]) {
    if (shell && (await pathExists(shell, constants.X_OK))) return shell;
  }
  return "/bin/sh";
}

let spawnHelperChecked = process.platform !== "darwin";

async function ensureSpawnHelperExecutable() {
  if (spawnHelperChecked) return;
  spawnHelperChecked = true;
  const require = createRequire(import.meta.url);
  const packageDir = path.dirname(require.resolve("node-pty/package.json"));
  const prebuilt = `prebuilds/${process.platform}-${process.arch}`;
  for (const nativeDir of ["build/Release", prebuilt]) {
    const helper = path.join(packageDir, nativeDir, "spawn-helper");
    if (!(await pathExists(helper, constants.X_OK))) {
      await fs.chmod(helper, 0o755).catch(() => undefined);
    }
  }
}

function titleFor(start: TerminalStart, shell: string) {
  if (start.mode === "shell") return path.basename(shell) || "Terminal";
  const command = start.command.trim().replace(/\s+/gu, " ");
  return command.length <= TITLE_MAX_LENGTH
    ? command
    : `${command.slice(0, TITLE_MAX_LENGTH - 3)}...`;
}

export function createTerminals(ctx: Ctx): Terminals {
  const terminals = new Map<string, Terminal>();

  const find = (terminalId: string, live: boolean) => {
    const terminal = terminals.get(terminalId);
    return terminal === undefined || (live && terminal.exited !== null)
      ? fail("terminal_not_found", `Terminal is not open: ${terminalId}`)
      : terminal;
  };

  const forget = (terminal: Terminal) => {
    if (terminals.get(terminal.id) === terminal) terminals.delete(terminal.id);
  };

  const trimScrollback = (terminal: Terminal, maxBytes: number) => {
    while (
      terminal.scrollback.length > 1 &&
      (terminal.scrollbackBytes > maxBytes ||
        terminal.scrollback.length > SCROLLBACK_MAX_CHUNKS)
    ) {
      terminal.scrollbackBytes -= terminal.scrollback.shift()?.byteLength ?? 0;
    }
  };

  const flush = (terminal: Terminal) => {
    clearTimeout(terminal.flushTimer ?? undefined);
    terminal.flushTimer = null;
    const output = Buffer.concat(terminal.pending);
    terminal.pending = [];
    for (let at = 0; at < output.byteLength; at += OUTPUT_CHUNK_MAX_BYTES) {
      const bytes = output.subarray(at, at + OUTPUT_CHUNK_MAX_BYTES);
      const dataBase64 = bytes.toString("base64");
      const chunk = { seq: terminal.nextSeq, dataBase64 };
      terminal.nextSeq += 1;
      terminal.scrollback.push({ chunk, byteLength: bytes.byteLength });
      terminal.scrollbackBytes += bytes.byteLength;
      trimScrollback(terminal, SCROLLBACK_MAX_BYTES);
      const terminalId = terminal.id;
      ctx.sink({ lane: "live", kind: "terminal.output", terminalId, ...chunk });
    }
  };

  const receive = (terminal: Terminal, data: string) => {
    if (terminal.exited !== null) return;
    const input = terminal.partialQuery + data;
    const partials = DEVICE_ATTRIBUTES_PARTIALS;
    const held = partials.find((partial) => input.endsWith(partial)) ?? "";
    terminal.partialQuery = held;
    const complete = input.slice(0, input.length - held.length);
    const output = complete.replace(DEVICE_ATTRIBUTES_QUERY, "");
    const queries = complete.match(DEVICE_ATTRIBUTES_QUERY)?.length ?? 0;
    if (queries > 0) {
      const replies = Math.min(queries, DEVICE_ATTRIBUTES_MAX_REPLIES);
      terminal.pty.write(DEVICE_ATTRIBUTES_REPLY.repeat(replies));
    }
    terminal.pending.push(Buffer.from(output, "utf8"));
    const pendingBytes = terminal.pending.reduce(
      (total, bytes) => total + bytes.byteLength,
      0,
    );
    if (pendingBytes >= OUTPUT_CHUNK_MAX_BYTES) {
      flush(terminal);
    } else {
      const flushLater = (): void => flush(terminal);
      terminal.flushTimer ??= setTimeout(flushLater, OUTPUT_BATCH_DELAY_MS);
    }
  };

  const finish = (terminal: Terminal, exitCode: number | null) => {
    if (terminal.exited !== null) return;
    terminal.pending.push(Buffer.from(terminal.partialQuery, "utf8"));
    flush(terminal);
    clearTimeout(terminal.closeTimer ?? undefined);
    terminal.exited = { exitCode };
    trimScrollback(terminal, EXITED_SCROLLBACK_MAX_BYTES);
    setTimeout(() => forget(terminal), EXITED_RETENTION_MS).unref();
    const exited = [...terminals.values()].filter((other) => other.exited);
    exited.slice(0, -EXITED_MAX_TERMINALS).forEach(forget);
    const terminalId = terminal.id;
    ctx.sink({ lane: "live", kind: "terminal.exited", terminalId, exitCode });
  };

  const kill = (terminal: Terminal, signal: NodeJS.Signals) => {
    try {
      process.kill(-terminal.pty.pid, signal);
    } catch {
      terminal.pty.kill(signal);
    }
  };

  const open: Terminals["open"] = async (args) => {
    const previous = terminals.get(args.terminalId);
    if (previous !== undefined && previous.exited === null) {
      fail("conflict", "Terminal session is already open");
    }
    if (process.platform === "win32") {
      fail("unavailable", "Native Windows terminals are not supported");
    }
    const cwd = requireAbsolute(args.cwd ?? os.homedir(), "Terminal cwd");
    if (!(await fs.stat(cwd)).isDirectory()) {
      fail("invalid_path", `Terminal cwd is not a directory: ${cwd}`);
    }
    const [shell, baseEnv] = await Promise.all([
      resolveShell(),
      ctx.env(),
      ensureSpawnHelperExecutable(),
    ]);
    const { start, cols, rows } = args;
    const shellArgs = start.mode === "shell" ? ["-l"] : ["-lc", start.command];
    const env = {
      ...baseEnv,
      ...TERMINAL_ENV,
      BB_TERMINAL_SESSION_ID: args.terminalId,
      ...args.env,
    };
    const name = TERMINAL_ENV.TERM;
    const pty = spawnPty(shell, shellArgs, { name, cols, rows, cwd, env });
    const terminal = new Terminal(args.terminalId, pty, cols, rows);
    terminals.set(terminal.id, terminal);
    pty.onData((data) => receive(terminal, data));
    pty.onExit(({ exitCode }) => finish(terminal, exitCode));
    const title = titleFor(start, shell);
    return { shell, title, initialCwd: cwd, cols, rows };
  };

  return {
    open: (args) => ctx.lock(`terminal:${args.terminalId}`, () => open(args)),
    async attach({ terminalId, sinceSeq, tailBytes }) {
      const terminal = find(terminalId, false);
      flush(terminal);
      const window = terminal.scrollback.filter(
        (entry) => entry.chunk.seq >= sinceSeq,
      );
      const bytesOf = (entries: typeof window) =>
        entries.reduce((total, entry) => total + entry.byteLength, 0);
      while (window.length > 1 && bytesOf(window) > tailBytes) window.shift();
      const page = [...window];
      const limit = TERMINAL_REPLAY_MAX_BYTES;
      while (page.length > 1 && bytesOf(page) > limit) page.pop();
      return {
        chunks: page.map((entry) => entry.chunk),
        replayStartSeq: page[0]?.chunk.seq ?? terminal.nextSeq,
        nextSeq: terminal.nextSeq,
        exited: terminal.exited,
      };
    },
    async write({ terminalId, dataBase64 }) {
      find(terminalId, true).pty.write(Buffer.from(dataBase64, "base64"));
    },
    async resize({ terminalId, cols, rows }) {
      const terminal = find(terminalId, true);
      if (terminal.cols !== cols || terminal.rows !== rows) {
        Object.assign(terminal, { cols, rows });
        terminal.pty.resize(cols, rows);
      }
    },
    async close({ terminalId }) {
      const terminal = terminals.get(terminalId);
      if (!terminal || terminal.exited || terminal.closeTimer) return;
      terminal.closeTimer = setTimeout(() => {
        kill(terminal, "SIGKILL");
        finish(terminal, null);
      }, CLOSE_GRACE_MS);
      kill(terminal, "SIGHUP");
    },
    liveIds: () =>
      [...terminals.values()]
        .filter((terminal) => terminal.exited === null)
        .map((terminal) => terminal.id),
    dispose() {
      for (const terminal of terminals.values()) {
        if (terminal.exited === null) {
          kill(terminal, "SIGKILL");
          finish(terminal, null);
        }
        forget(terminal);
      }
    },
  };
}
