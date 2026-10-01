import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";

type ExitListener = (code: number | null, signal: string | null) => void;
export type AppServerChild = ChildProcessWithoutNullStreams;
type Launch = { cwd: string; env: Record<string, string> };

export type SpawnAppServer = (
  command: string,
  args: string[],
  options: Launch,
) => AppServerChild;

export interface RpcHandlers {
  onNotification(method: string, params: unknown): void;
  onRequest(id: string | number, method: string, params: unknown): void;
  onExit(info: { message: string; stderrTail: string }): void;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly spawnFailed = false,
  ) {
    super(message);
  }
}

const messageSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z
    .object({ code: z.number().optional(), message: z.string().optional() })
    .optional(),
});
const REQUEST_TIMEOUT_MS = 60_000;
const STDERR_TAIL_LINES = 40;

export const spawnAppServer: SpawnAppServer = (command, args, options) =>
  spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });

function readLines(stream: Readable, onLine: (line: string) => void) {
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  stream.on("data", (chunk: Buffer | string) => {
    buffered += typeof chunk === "string" ? chunk : decoder.write(chunk);
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  });
}

export class CodexRpc {
  exited = false;
  private nextId = 1;
  private killing = false;
  private spawnFailed = false;
  private stderrTail: string[] = [];
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  private readonly closed: Promise<void>;

  constructor(
    private readonly child: AppServerChild,
    private readonly handlers: RpcHandlers,
  ) {
    readLines(child.stdout, (line) => this.receive(line));
    readLines(child.stderr, (line) => {
      this.stderrTail = [...this.stderrTail, line].slice(-STDERR_TAIL_LINES);
    });
    child.stdin.on("error", () => child.kill("SIGKILL"));
    this.closed = new Promise((resolve) => {
      const finish: ExitListener = (code, signal) => {
        if (!this.exited) this.finalize(code, signal);
        resolve();
      };
      child.on("close", finish);
      const linger = (...status: Parameters<ExitListener>) =>
        setTimeout(finish, 1_000, ...status).unref();
      child.on("exit", linger);
      child.on("error", (error) => {
        this.spawnFailed = true;
        this.stderrTail.push(error.message);
        finish(null, null);
      });
    });
  }

  request(method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (this.exited || this.killing) {
      const message = "codex app-server is not running";
      return Promise.reject(new RpcError(message, undefined, this.spawnFailed));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const expire = () => {
        const message = `codex app-server did not answer ${method} in time`;
        if (this.pending.delete(id)) reject(new RpcError(message));
      };
      setTimeout(expire, timeoutMs).unref();
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  respond(id: string | number, result: unknown) {
    this.write({ jsonrpc: "2.0", id, result: result ?? null });
  }

  reject(id: string | number, code: number, message: string) {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  kill() {
    if (this.exited || this.killing) return this.closed;
    this.killing = true;
    setTimeout(() => this.exited || this.child.kill("SIGTERM"), 1_000).unref();
    setTimeout(() => this.exited || this.child.kill("SIGKILL"), 4_000).unref();
    this.child.stdin.end();
    return this.closed;
  }

  private write(message: object) {
    const { stdin } = this.child;
    if (this.exited || this.killing || !stdin.writable) return;
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string) {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return;
    }
    const parsed = messageSchema.safeParse(json);
    if (!parsed.success || this.exited) return;
    const { id, method, params, result, error } = parsed.data;
    if (method !== undefined && id !== undefined) {
      this.handlers.onRequest(id, method, params);
    } else if (method !== undefined) {
      this.handlers.onNotification(method, params);
    } else if (id !== undefined) {
      const request = this.pending.get(Number(id));
      this.pending.delete(Number(id));
      const message = error?.message ?? "codex app-server returned an error";
      if (error) request?.reject(new RpcError(message, error.code));
      else request?.resolve(result);
    }
  }

  private finalize(code: number | null, signal: string | null) {
    this.exited = true;
    const stderrTail = this.stderrTail.join("\n");
    const status = `code ${code ?? "null"}, signal ${signal ?? "null"}`;
    const suffix = stderrTail ? `: ${stderrTail}` : "";
    const message = `codex app-server exited (${status})${suffix}`;
    for (const request of this.pending.values()) {
      request.reject(new RpcError(message, undefined, this.spawnFailed));
    }
    this.pending.clear();
    if (!this.killing) this.handlers.onExit({ message, stderrTail });
  }
}
