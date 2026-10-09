import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { server as serverContract } from "@bb/plugin";
import { expect, it, vi } from "vitest";
import { createTestServer, scratch } from "./helpers.js";

it("keeps a plugin's themes across a reload and versions them by file", async () => {
  const directory = join(scratch(), "echo");
  mkdirSync(directory, { recursive: true });
  const themes = [{ id: "dusk", name: "Dusk", css: "./dusk.css" }];
  const manifest = { name: "echo", bb: { name: "Echo", themes } };
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
  const cssFile = join(directory, "dusk.css");
  writeFileSync(cssFile, ":root { --canvas: #111; }");
  const server = await createTestServer();
  const { ctx } = server;
  const configFile = join(ctx.config.dataDir, "config.json");
  writeFileSync(configFile, JSON.stringify({ plugins: [{ path: directory }] }));
  await ctx.plugins.reload();
  type Config = { themes: { cssUrl: string }[] };
  const urls = async () =>
    (await server.read<Config>("/server/config")).themes.map((t) => t.cssUrl);
  const [first] = await urls();
  expect(first).toMatch(/\/echo\/themes\/dusk\.css\?v=\d+$/u);
  await ctx.plugins.reload("echo");
  expect(await urls()).toEqual([first]);
  const announced = vi.spyOn(ctx.kernel, "changed");
  writeFileSync(cssFile, ":root { --canvas: #222; }");
  utimesSync(cssFile, new Date(), new Date(Date.now() + 5000));
  await vi.waitFor(async () => {
    const [next] = await urls();
    expect(next).not.toBe(first);
    expect(next).toMatch(/\/echo\/themes\/dusk\.css\?v=\d+$/u);
  });
  expect(announced).toHaveBeenCalledWith(serverContract.config);
  announced.mockClear();
  await ctx.plugins.setEnabled("echo", false);
  expect(await urls()).toEqual([]);
  expect(announced).toHaveBeenCalledWith(serverContract.config);
});
