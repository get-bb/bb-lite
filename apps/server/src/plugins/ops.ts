import { resolve } from "node:path";
import { plugins, type PluginVerbs } from "@bb/plugin";
import { dataPaths } from "@bb/server-kit/config";
import {
  callDoorTool,
  doorInstructions,
  doorTools,
} from "@bb/server-kit/doors";
import type { HostContext } from "../host-context.js";
import { readManifest, writeExternalPluginEntry } from "./manifest.js";

export function hostOps(ctx: HostContext, bb: PluginVerbs): void {
  const { kernel } = ctx;
  const { configFile } = dataPaths(ctx.config.dataDir);
  bb.implement(plugins.inspect, () => kernel.inspect());
  bb.implement(plugins.agentInstructions, (context) =>
    doorInstructions(kernel, context),
  );
  bb.implement(plugins.agentTools, (context) => doorTools(kernel, context));
  bb.implement(
    plugins.callAgentTool,
    async ({ name, input, context }, { signal }) => {
      const scope = { ...context, signal };
      const answered = await callDoorTool(kernel, name, input, scope);
      if (answered !== null) return answered;
      const text = `Unknown tool "${name}"`;
      const item = { type: "inputText" as const, text };
      return { contentItems: [item], success: false };
    },
  );
  bb.implement(plugins.skillDirs, () => ctx.plugins.skillDirs());
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
