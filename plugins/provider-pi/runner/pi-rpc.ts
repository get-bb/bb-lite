import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";

export interface PiChild {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(): boolean;
  channel?: { input: Readable; output: Writable };
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

export const spawnPi: SpawnPi = ({ command, args, cwd, env }) => {
  const stdio = ["pipe", "pipe", "pipe", "pipe", "pipe"] as const;
  const child = spawn(command, args, { cwd, env, stdio: [...stdio] });
  const input = child.stdio[3];
  const output = child.stdio[4];
  const channel =
    input && output && "on" in input && "write" in output
      ? { input: input as Readable, output: output as Writable }
      : undefined;
  return Object.assign(child, { channel });
};

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
      onChannel?: (message: Record<string, unknown>) => void;
      onUiRequest?: (
        request: Record<string, unknown>,
      ) => Promise<Record<string, unknown> | undefined>;
      onExit: (info: { message: string; stderrTail: string }) => void;
    },
  ) {
    onLines(child.stdout, (line) => {
      const message = parse(line);
      if (message === undefined) return;
      const response = responseSchema.safeParse(message);
      if (response.success) return this.settle(response.data);
      if (message.type === "extension_ui_request") {
        return this.answerUi(message, handlers.onUiRequest);
      }
      if (typeof message.type === "string") handlers.onEvent(message);
    });
    const channel = child.channel;
    if (channel && handlers.onChannel) {
      const onChannel = handlers.onChannel;
      onLines(channel.input, (line) => {
        const message = parse(line);
        if (message !== undefined) onChannel(message);
      });
    }
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

  sendChannel(message: Record<string, unknown>) {
    const output = this.child.channel?.output;
    if (!this.exited && output) output.write(`${JSON.stringify(message)}\n`);
  }

  private answerUi(
    request: Record<string, unknown>,
    answer?: (
      request: Record<string, unknown>,
    ) => Promise<Record<string, unknown> | undefined>,
  ) {
    const type = "extension_ui_response";
    const cancelled = { cancelled: true };
    const reply = (fields: Record<string, unknown> | undefined) => {
      if (fields !== undefined) this.write({ type, id: request.id, ...fields });
    };
    if (!answer) return reply(cancelled);
    answer(request).then(reply, () => reply(cancelled));
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

function onLines(stream: Readable, onLine: (line: string) => void) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  stream.on("data", (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    const lines = `${pending}${text}`.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) onLine(line.replace(/\r$/, ""));
  });
}

function parse(line: string) {
  try {
    const parsed = messageSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
