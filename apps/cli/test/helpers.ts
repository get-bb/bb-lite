import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEchoAdapter } from "@bb/runner";
import { onTestFinished } from "vitest";
import type { ServerConfig } from "../../server/src/config.js";
import { localRunnerFor } from "../../server/src/runners/local.js";
import { createTestServer } from "../../server/test/helpers.js";
import { createProject } from "../../server/test/watch.js";

export interface BbResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const at = (path: string): string =>
  fileURLToPath(new URL(path, import.meta.url));
const ENTRY = at("../src/index.ts");
const TSX_LOADER = at("../../../node_modules/tsx/dist/loader.mjs");
const NODE_ARGS = ["--conditions=source", "--import", TSX_LOADER, ENTRY];

export async function runBb(
  args: string[],
  env: Record<string, string> = {},
  stdin = "",
): Promise<BbResult> {
  const { PATH = "", HOME = "" } = process.env;
  const options = {
    env: { PATH, HOME, BB_SERVER_URL: "http://127.0.0.1:9", ...env },
  };
  const child = spawn(process.execPath, [...NODE_ARGS, ...args], options);
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => (output.stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (output.stderr += String(chunk)));
  child.stdin.end(stdin);
  const [code] = (await once(child, "close")) as [number | null];
  return { code, ...output };
}

export async function startBb() {
  const localRunner = (config: ServerConfig) => {
    const local = localRunnerFor(config, [createEchoAdapter()]);
    onTestFinished(local.shutdown);
    return local.connect;
  };
  const server = await createTestServer({}, { localRunner });
  const { ctx } = server;
  const directory = join(ctx.config.dataDir, "repo");
  mkdirSync(directory);
  const project = await createProject(server, "cli", directory);
  const BB_SERVER_URL = server.url;
  const bb = (args: string[], env: Record<string, string> = {}, stdin = "") =>
    runBb(args, { BB_SERVER_URL, BB_PROJECT_ID: project.id, ...env }, stdin);
  return { ctx, project, bb };
}

export function parsed<Shape>(result: BbResult): Shape {
  return JSON.parse(result.stdout) as Shape;
}
