import { runnerParts } from "@bb/profile-default/runner";
import { profilePlugins } from "@bb/profile-default/server";
import { loadConfig, type ServerEnv } from "./config.js";
import { localRunnerFor } from "./runners/local.js";
import { createServer, type BbServer } from "./server.js";

export interface StartServerOptions {
  env?: ServerEnv;
  cliDir?: string;
}

export async function startServer(
  options: StartServerOptions = {},
): Promise<BbServer> {
  const env = options.env ?? process.env;
  const loaded = loadConfig(env);
  const config = { ...loaded, cliDir: options.cliDir ?? loaded.cliDir };
  const local = localRunnerFor(config, { parts: runnerParts });
  const builtins = profilePlugins(config.profile);
  const localRunner = local.connect;
  const server = createServer({ config, localRunner, builtins });
  const { url } = await server.listen();
  const { dataDir, version } = config;
  server.ctx.log.info("bb server listening", { url, dataDir, version });
  const shutdown = () => {
    process.off("SIGINT", shutdown).off("SIGTERM", shutdown);
    const stopped = server.close().then(local.shutdown);
    stopped.then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", shutdown).on("SIGTERM", shutdown);
  return server;
}
