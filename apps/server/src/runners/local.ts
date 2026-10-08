import { join } from "node:path";
import {
  createLocalRunner,
  type LocalRunner,
  type ProviderAdapter,
  type RunnerPart,
} from "@bb/runner";
import { loopbackUrl, type ServerConfig } from "../config.js";
import type { ServerRunner } from "../context.js";
import type { RunnerFactory } from "./registry.js";

export function localRunnerFor(
  config: ServerConfig,
  providers: { adapters?: ProviderAdapter[]; parts?: RunnerPart[] },
) {
  let runner: LocalRunner | undefined;
  const connect: RunnerFactory<ServerRunner> = (sink) => {
    const { dataDir } = config;
    const serverUrl = loopbackUrl(config);
    const bbCliPath = join(config.cliDir, "bin", "bb");
    const paths = { dataDir, serverUrl, bbCliPath };
    runner = createLocalRunner({ ...paths, sink, ...providers });
    return runner;
  };
  return { connect, shutdown: async () => runner?.shutdown() };
}
