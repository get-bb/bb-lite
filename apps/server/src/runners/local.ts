import { fileURLToPath } from "node:url";
import {
  createLocalRunner,
  type LocalRunner,
  type ProviderAdapter,
} from "@bb/runner";
import { loopbackUrl, type ServerConfig } from "../config.js";
import type { ServerRunner } from "../context.js";
import type { RunnerFactory } from "./registry.js";

const BB_CLI_PATH = fileURLToPath(
  new URL("../../../cli/bin/bb", import.meta.url),
);

export function localRunnerFor(
  config: ServerConfig,
  adapters: ProviderAdapter[],
) {
  let runner: LocalRunner | undefined;
  const connect: RunnerFactory<ServerRunner> = (sink) => {
    const { dataDir } = config;
    const serverUrl = loopbackUrl(config);
    const paths = { dataDir, serverUrl, bbCliPath: BB_CLI_PATH };
    runner = createLocalRunner({ ...paths, sink, adapters });
    return runner;
  };
  return { connect, shutdown: async () => runner?.shutdown() };
}
