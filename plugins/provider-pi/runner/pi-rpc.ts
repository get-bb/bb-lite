import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";

export interface PiChild {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(): boolean;
}
export interface PiLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}
export type SpawnPi = (launch: PiLaunch) => PiChild;

export const COMMAND_ENV = "BB_PI_BRIDGE_COMMAND";
export const ARGS_ENV = "BB_PI_BRIDGE_ARGS";

const responseSchema = z.object({
  type: z.literal("response"),
  id: z.string(),
  success: z.boolean().optional(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
const messageSchema = z.record(z.string(), z.unknown());

export const spawnPi: SpawnPi = ({ command, args, cwd, env }) =>
  spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });

export function piCommand(env: Record<string, string | undefined>) {
  const command = env[COMMAND_ENV]?.trim();
  if (!command) return { command: "pi", args: [] };
  const raw = env[ARGS_ENV];
  if (!raw) return { command, args: [] };
  const parsed = z.array(z.string()).safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`${ARGS_ENV} must be a JSON array of strings`);
  }
  return { command, args: parsed.data };
}

export class PiRpcError extends Error {
  constructor(
    message: string,
    readonly spawnFailed = false,
  ) {
    super(message);
  }
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
}

export class PiRpc {
  private readonly pending = new Map<string, Pending>();
  private nextId = 0;
  private stderrTail = "";
  exited = false;

  constructor(
    private readonly child: PiChild,
    handlers: {
      onEvent: (event: Record<string, unknown>) => void;
      onExit: (info: { message: string; stderrTail: string }) => void;
    },
  ) {
    createInterface({ input: child.stdout }).on("line", (line) => {
      const message = parse(line);
      if (message === undefined) return;
      const response = responseSchema.safeParse(message);
      if (response.success) return this.settle(response.data);
      if (message.type === "extension_ui_request") {
        const cancel = { type: "extension_ui_response", cancelled: true };
        return this.write({ ...cancel, id: message.id });
      }
      if (typeof message.type === "string") handlers.onEvent(message);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-4000);
    });
    const fail = (message: string, spawnFailed: boolean) => {
      if (this.exited) return;
      this.exited = true;
      for (const pending of this.pending.values()) {
        pending.reject(new PiRpcError(message, spawnFailed));
      }
      this.pending.clear();
      handlers.onExit({ message, stderrTail: this.stderrTail });
    };
    child.on("error", (error) => fail(error.message, true));
    child.on("exit", (code) => fail(`pi exited with code ${code}`, false));
  }

  request(command: Record<string, unknown>) {
    if (this.exited) return Promise.reject(new PiRpcError("pi is not running"));
    const id = `bb-${(this.nextId += 1)}`;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ ...command, id });
    });
  }

  close() {
    if (!this.exited) this.child.kill();
  }

  private write(message: Record<string, unknown>) {
    if (!this.exited) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private settle(response: z.infer<typeof responseSchema>) {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.success === false) {
      pending.reject(new PiRpcError(response.error ?? "Pi request failed"));
    } else {
      pending.resolve(response.data);
    }
  }
}

function parse(line: string) {
  try {
    const parsed = messageSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
