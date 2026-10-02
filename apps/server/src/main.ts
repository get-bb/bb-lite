import { LegacyDataDirectoryError } from "./db/index.js";
import { startServer } from "./start.js";

startServer().catch((error: unknown) => {
  console.error(
    error instanceof LegacyDataDirectoryError ? error.message : error,
  );
  process.exit(1);
});
