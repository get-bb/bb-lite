import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["source"],
  },
  ssr: {
    resolve: {
      conditions: ["source"],
    },
  },
  test: {
    include: ["{apps,packages,plugins}/*/test/**/*.test.{ts,tsx}"],
    environment: "node",
    testTimeout: 20_000,
    pool: "forks",
  },
});
