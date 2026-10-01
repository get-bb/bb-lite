import { defaultAdapters } from "@bb/runner";
import { loadConfig } from "./config.js";
import { LegacyDataDirectoryError } from "./db/index.js";
import { localRunnerFor } from "./runners/local.js";
import { createServer } from "./server.js";

function fail(error: unknown): never {
  console.error(
    error instanceof LegacyDataDirectoryError ? error.message : error,
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const dev = (process.env.BB_DEV_PROVIDERS ?? "").split(",");
  const adapters = defaultAdapters().filter(
    (adapter) => adapter.id !== "echo" || dev.includes("echo"),
  );
  const local = localRunnerFor(config, adapters);
  const server = createServer({ config, localRunner: local.connect });
  const { url } = await server.listen();
  const { dataDir, version } = config;
  server.ctx.log.info("bb server listening", { url, dataDir, version });
  const shutdown = (): void => {
    process.off("SIGINT", shutdown).off("SIGTERM", shutdown);
    const stopped = server.close().then(local.shutdown);
    stopped.then(() => process.exit(0), fail);
  };
  process.on("SIGINT", shutdown).on("SIGTERM", shutdown);
}

main().catch(fail);
