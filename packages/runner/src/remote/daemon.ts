import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { z } from "zod";
import { createLocalRunner } from "../local.js";
import type { RunnerPart } from "../plugins.js";
import type { ProviderAdapter } from "../providers/provider.js";
import { startCliProxy } from "./cli-proxy.js";
import { OUTDATED_CLOSE_CODE, REPLACED_CLOSE_CODE } from "./protocol.js";
import { serveRunner, type RunnerServing } from "./serve.js";

const CREDENTIALS_FILE = "runner.json";
const CONNECT_MACHINE_HEADER = "x-bb-connect-machine";
const CONNECT_TIMEOUT_MS = 10_000;
const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 10_000;
const HEADER_PAIR = /^([a-z0-9-]+)=(.+)$/iu;

const headersSchema = z.record(z.string(), z.string());
const joinBlobSchema = z.object({
  serverUrl: z.url(),
  hostId: z.string().min(1),
  joinToken: z.string().min(1),
  headers: headersSchema.optional(),
});
const joinReplySchema = z.object({
  hostId: z.string().min(1),
  runnerToken: z.string().min(1),
});
const credentialsSchema = joinReplySchema.extend({
  serverUrl: z.url(),
  headers: headersSchema,
});
const legacyMachineConfigSchema = z.object({
  serverHeaders: headersSchema.optional(),
  machineCredential: z.string().min(1).optional(),
});

export interface JoinOptions {
  blob: string;
  dataDir?: string;
  hostName?: string;
  headers?: string[];
  legacyMachineConfigPath?: string;
}

export interface RunOptions {
  dataDir: string;
  bbCliPath: string;
  adapters?: ProviderAdapter[];
  parts?: RunnerPart[];
  log?: (message: string) => void;
}

export interface RunningRunner {
  cliProxyUrl: string;
  stopped: Promise<void>;
  stop(): Promise<void>;
}

export function defaultRunnerDataDir(serverUrl: string): string {
  return join(homedir(), ".bb-150k-runner", new URL(serverUrl).host);
}

export function defaultLegacyMachineConfigPath(serverUrl: string): string {
  const serverHost = new URL(serverUrl).host;
  return join(homedir(), ".bb-machines", serverHost, "config.json");
}

function parseHeaderPair(pair: string) {
  const [, name, value] = HEADER_PAIR.exec(pair) ?? [];
  if (name && value) return [name.toLowerCase(), value];
  throw new Error(`Expected a header as name=value, got "${pair}"`);
}

async function readLegacyHeaders(path: string) {
  const stored: unknown = JSON.parse(await readFile(path, "utf8"));
  const config = legacyMachineConfigSchema.parse(stored);
  if (config.serverHeaders !== undefined) return config.serverHeaders;
  if (config.machineCredential === undefined) {
    throw new Error(`${path} holds no bb connect machine credential`);
  }
  return { [CONNECT_MACHINE_HEADER]: config.machineCredential };
}

export async function joinServer(options: JoinOptions) {
  const decoded = Buffer.from(options.blob, "base64url").toString("utf8");
  const blob = joinBlobSchema.parse(JSON.parse(decoded));
  const serverUrl = blob.serverUrl.replace(/\/+$/u, "");
  const legacyPath = options.legacyMachineConfigPath;
  const headers = {
    ...blob.headers,
    ...(legacyPath === undefined ? {} : await readLegacyHeaders(legacyPath)),
    ...Object.fromEntries((options.headers ?? []).map(parseHeaderPair)),
  };
  const dataDir = options.dataDir ?? defaultRunnerDataDir(serverUrl);
  await mkdir(dataDir, { recursive: true });
  const response = await fetch(`${serverUrl}/internal/runner/join`, {
    method: "POST",
    headers: {
      ...headers,
      authorization: `Bearer ${blob.joinToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ hostName: options.hostName ?? hostname() }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`The server refused to join: ${response.status} ${detail}`);
  }
  const reply = joinReplySchema.parse(await response.json());
  const credentials = { ...reply, serverUrl, headers };
  const file = join(dataDir, CREDENTIALS_FILE);
  const content = `${JSON.stringify(credentials, null, 2)}\n`;
  await writeFile(file, content, { mode: 0o600 });
  await chmod(file, 0o600);
  return { ...credentials, dataDir };
}

export async function runRunner(options: RunOptions): Promise<RunningRunner> {
  const log = options.log ?? ((message) => console.error(message));
  const file = join(options.dataDir, CREDENTIALS_FILE);
  const stored: unknown = JSON.parse(await readFile(file, "utf8"));
  const { serverUrl, headers, runnerToken } = credentialsSchema.parse(stored);
  const proxy = await startCliProxy({ serverUrl, headers, runnerToken });
  const target = `${serverUrl.replace(/^http/u, "ws")}/internal/runner/ws`;
  const authorization = `Bearer ${runnerToken}`;
  let serving: RunnerServing | null = null;
  let socket: WebSocket | null = null;
  let retry: NodeJS.Timeout | null = null;
  let retryMs = MIN_RETRY_MS;
  let stopping: Promise<void> | null = null;

  const runner = createLocalRunner({
    dataDir: options.dataDir,
    serverUrl: proxy.url,
    bbCliPath: options.bbCliPath,
    adapters: options.adapters,
    parts: options.parts,
    log,
    sink: (event) => serving?.deliver(event),
  });

  let markStopped: () => void = () => {};
  const stopped = new Promise<void>((resolve) => (markStopped = resolve));
  const shutDown = async () => {
    process.off("SIGINT", stop).off("SIGTERM", stop);
    if (retry !== null) clearTimeout(retry);
    await runner.shutdown();
    socket?.terminate();
    await proxy.close();
    markStopped();
  };
  const stop = () => (stopping ??= shutDown());

  const dial = () => {
    const connection = new WebSocket(target, {
      headers: { ...headers, authorization },
      handshakeTimeout: CONNECT_TIMEOUT_MS,
    });
    socket = connection;
    connection.on("open", () => {
      retryMs = MIN_RETRY_MS;
      serving = serveRunner(runner, connection);
    });
    connection.on("error", (error) => {
      log(`bb runner: connection error: ${error.message}`);
    });
    connection.on("close", (code) => {
      serving = null;
      if (stopping !== null) return;
      if (code === REPLACED_CLOSE_CODE) {
        log("bb runner: this machine was replaced or removed; stopping");
        return void stop();
      }
      if (code === OUTDATED_CLOSE_CODE) {
        log(
          "bb runner: the server speaks a different plugin API version; " +
            "update bb on this machine and start the runner again",
        );
        return void stop();
      }
      log(`bb runner: disconnected (${code}); retrying in ${retryMs} ms`);
      retry = setTimeout(dial, retryMs);
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
    });
  };

  process.once("SIGINT", stop).once("SIGTERM", stop);
  dial();
  return { cliProxyUrl: proxy.url, stopped, stop };
}
