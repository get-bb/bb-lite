import { basename } from "node:path";
import { profilePlugins } from "@bb/profile-default/server";
import { expect, it } from "vitest";
import { corePlugins, inStartOrder } from "../src/core/plugins.js";
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

it("starts core plugins in the order their requirements give", async () => {
  const order = inStartOrder(corePlugins).map(({ id }) => id);
  const before = (first: string, second: string) =>
    expect(order.indexOf(first)).toBeLessThan(order.indexOf(second));
  before("machines", "threads");
  before("projects", "threads");
  before("threads", "environments");
  before("environments", "plugins");
  before("plugins", "terminals");
  before("terminals", "workspace");
  expect(order).toHaveLength(corePlugins.length);
  const server = await createTestServer();
  const listed = await server.read<{
    plugins: { id: string; tier: string }[];
    ops: { name: string; owner: string | null }[];
  }>("/kernel");
  const loaded = listed.plugins.map(({ id }) => id);
  for (const { id } of corePlugins) expect(loaded).toContain(id);
  expect(loaded).toContain("tasks");
  const unowned = listed.ops.filter(({ owner }) => owner === null);
  expect(unowned).toEqual([]);
});
