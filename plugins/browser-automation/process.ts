import { spawn } from "node:child_process";

const supervisor = `
const { spawn } = require('node:child_process');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(process.argv[1], process.argv.slice(2), { detached: true, stdio: 'ignore', env });
let stopping = false;
function kill(signal) { if (child.pid) { try { process.kill(-child.pid, signal); } catch {} } }
function stop() {
  if (stopping) return;
  stopping = true;
  kill('SIGTERM');
  setTimeout(() => {
    kill('SIGKILL');
    if (child.exitCode !== null || child.signalCode !== null) process.exit(0);
    else child.once('exit', () => process.exit(0));
  }, 1500);
}
child.on('error', () => process.exit(1));
child.on('exit', () => { if (!stopping) { kill('SIGKILL'); process.exit(1); } });
process.stdin.resume();
process.stdin.on('end', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
`;

export const MAX_OUTPUT_BYTES = 512_000;

export interface Supervised {
  alive(): boolean;
  close(): Promise<void>;
}

export function supervise(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Supervised {
  const child = spawn(process.execPath, ["-e", supervisor, command, ...args], {
    env: process.versions.electron
      ? { ...env, ELECTRON_RUN_AS_NODE: "1" }
      : env,
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.stdin.on("error", () => undefined);
  let exited = false;
  const completion = new Promise<void>((resolve) => {
    const done = () => {
      exited = true;
      resolve();
    };
    child.once("exit", done);
    child.once("error", done);
  });
  return {
    alive: () => !exited,
    close: () => {
      child.stdin.end();
      return completion;
    },
  };
}

export function execute(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let bytes = 0;
    let failure: Error | null = null;
    const kill = (error: Error) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const abort = () => kill(new Error("Browser work cancelled or timed out"));
    const count = (size: number) => {
      bytes += size;
      if (bytes > MAX_OUTPUT_BYTES)
        kill(new Error("DevBrowser output exceeded 512 KB"));
      return bytes <= MAX_OUTPUT_BYTES;
    };
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (count(Buffer.byteLength(chunk))) stdout += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => count(chunk.length));
    child.once("error", (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", () => {
      signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else resolve(stdout);
    });
  });
}
