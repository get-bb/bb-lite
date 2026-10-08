import { LegacyDataDirectoryError } from "@bb/server-kit/db/index";
import { startServer } from "./start.js";

startServer().catch((error: unknown) => {
  console.error(
    error instanceof LegacyDataDirectoryError ? error.message : error,
  );
  process.exit(1);
});
