import { basename } from "node:path";
import { corePlugins, profilePlugins } from "@bb/profile-default/server";
import { expect, it } from "vitest";
import { createTestServer } from "./helpers.js";

const ids = (name: string) =>
  profilePlugins(name).map(({ directory }) => basename(directory));

it("picks the in-repo plugins a profile names", () => {
  expect(ids("minimal")).toEqual([
    "provider-codex",
    "provider-claude-code",
    "provider-echo",
    "plugin-dev",
  ]);
  expect(ids("headless")).not.toContain("thread-list");
  expect(ids("default")).toContain("thread-list");
  expect(ids("default")).toHaveLength(13);
  expect(() => profilePlugins("nope")).toThrow('Unknown profile "nope"');
});

it("loads core through the plugin loader, in the order requirements give", async () => {
  const server = await createTestServer();
  const core = corePlugins.map(({ directory }) => basename(directory));
  const listed = await server.read<{
    plugins: { id: string; tier: string }[];
    ops: { name: string; owner: string | null }[];
  }>("/kernel");
  const loaded = listed.plugins.map(({ id }) => id);
  const before = (first: string, second: string) =>
    expect(loaded.indexOf(first)).toBeLessThan(loaded.indexOf(second));
  for (const id of core) expect(loaded).toContain(id);
  before("machines", "threads");
  before("projects", "threads");
  before("threads", "environments");
  before("terminals", "workspace");
  before("workspace", "tasks");
  const unowned = listed.ops.filter(({ owner }) => owner === null);
  expect(unowned).toEqual([]);
  const plugins = server.ctx.plugins.list();
  const threads = plugins.find(({ id }) => id === "threads");
  expect(threads).toMatchObject({ core: true, status: "running" });
  const off = await server.send("/plugins/threads/disable", {});
  expect(off.status).toBe(409);
});
