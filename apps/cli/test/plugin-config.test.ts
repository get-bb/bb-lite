import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parsed, startBb } from "./helpers.js";

const FIXTURE = fileURLToPath(
  new URL("../../server/test/fixtures/echo-plugin", import.meta.url),
);

interface Settings {
  ok: boolean;
  values: Record<string, unknown>;
  error?: { code: string; message: string };
}

it("shows and changes a plugin's settings without echoing a secret", async () => {
  const { bb, ctx } = await startBb();
  const config = { plugins: [{ path: FIXTURE }] };
  const file = join(ctx.config.dataDir, "config.json");
  writeFileSync(file, JSON.stringify(config));
  await ctx.plugins.reload();
  const shown = await bb(["plugin", "config", "echo"]);
  expect(shown.code).toBe(0);
  expect(shown.stdout).toContain('greeting = "hello"');
  expect(shown.stdout).toContain("apiKey = (secret, unset)");
  const set = await bb(["plugin", "config", "echo", "set", "greeting", "hi"]);
  expect(set.stdout).toContain('greeting = "hi"');
  const secret = ["plugin", "config", "echo", "set", "apiKey", "s3cret"];
  const saved = await bb([...secret, "--json"]);
  expect(saved.code).toBe(0);
  expect(saved.stdout).not.toContain("s3cret");
  expect(parsed<Settings>(saved).values).toMatchObject({
    greeting: "hi",
    apiKey: { set: true },
  });
  const unset = await bb(["plugin", "config", "echo", "unset", "greeting"]);
  expect(unset.stdout).toContain('greeting = "hello"');
  const unknown = await bb(["plugin", "config", "echo", "set", "nope", "1"]);
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain("Unknown setting 'nope'");
  const missing = await bb(["plugin", "config", "nosuch", "--json"]);
  expect(missing.code).toBe(1);
  expect(parsed<Settings>(missing).ok).toBe(false);
});

it("stops loading a plugin named by its id", async () => {
  const { bb, ctx } = await startBb();
  const config = { plugins: [{ path: FIXTURE }] };
  const file = join(ctx.config.dataDir, "config.json");
  writeFileSync(file, JSON.stringify(config));
  await ctx.plugins.reload();
  const builtin = await bb(["plugin", "remove", "tasks", "--yes"]);
  expect(builtin.code).toBe(1);
  expect(builtin.stderr).toContain("is not a loaded plugin directory");
  const removed = await bb(["plugin", "remove", "echo", "--yes"]);
  expect(removed.code).toBe(0);
  expect(removed.stdout).toContain(`${FIXTURE} removed from`);
  expect(ctx.plugins.list().map(({ id }) => id)).not.toContain("echo");
});
