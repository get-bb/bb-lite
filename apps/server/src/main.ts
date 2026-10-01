import { loadConfig } from "./config.js";
import { LegacyDataDirectoryError } from "./db/index.js";
import { createUnavailableRunner } from "./runners/unavailable-runner.js";
import { createServer } from "./server.js";

function fail(error: unknown): never {
  console.error(
    error instanceof LegacyDataDirectoryError ? error.message : error,
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createServer({ config, localRunner: createUnavailableRunner });
  const { url } = await server.listen();
  const { dataDir, version } = config;
  server.ctx.log.info("bb server listening", { url, dataDir, version });
  const shutdown = (): void => {
    process.off("SIGINT", shutdown).off("SIGTERM", shutdown);
    server.close().then(() => process.exit(0), fail);
  };
  process.on("SIGINT", shutdown).on("SIGTERM", shutdown);
}

main().catch(fail);
