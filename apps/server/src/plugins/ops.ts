import { resolve } from "node:path";
import { plugins, type PluginVerbs } from "@bb/plugin";
import { dataPaths } from "@bb/server-kit/config";
import type { HostContext } from "../host-context.js";
import { readManifest, writeExternalPluginEntry } from "./manifest.js";

export function hostOps(ctx: HostContext, bb: PluginVerbs): void {
  const { kernel } = ctx;
  const { configFile } = dataPaths(ctx.config.dataDir);
  bb.implement(plugins.inspect, () => kernel.inspect());
  bb.implement(plugins.describe, ({ id }) => ctx.plugins.locate(id));
  bb.implement(plugins.reload, ({ id }) => ctx.plugins.reload(id));
  bb.implement(plugins.install, async ({ path, watch }) => {
    const { id } = await readManifest(path);
    await writeExternalPluginEntry(configFile, path, { watch });
    await ctx.plugins.refresh(id);
    return { id: ctx.plugins.idOfDirectory(path), path: resolve(path) };
  });
  bb.implement(plugins.uninstall, async ({ path }) => {
    const id = ctx.plugins.idOfDirectory(path);
    await writeExternalPluginEntry(configFile, path, null);
    if (id === null) await ctx.plugins.reload();
    else await ctx.plugins.refresh(id);
  });
}
