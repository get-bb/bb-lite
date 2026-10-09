import { resolve } from "node:path";
import { plugins, type PluginVerbs } from "@bb/plugin";
import { actorUserId } from "@bb/server-kit/auth/actor";
import { dataPaths } from "@bb/server-kit/config";
import {
  callDoorTool,
  doorInstructions,
  doorTools,
} from "@bb/server-kit/doors";
import { requireOwner } from "@bb/server-kit/http/trust";
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
  bb.implement(plugins.list, () => ({ plugins: ctx.plugins.list() }));
  bb.implement(plugins.contributions, () => ctx.plugins.contributions());
  bb.implement(plugins.reload, async ({ id }) => {
    await ctx.plugins.reload(id);
    return { ok: true as const, plugins: ctx.plugins.list() };
  });
  bb.implement(plugins.enable, async ({ pluginId }) => {
    const plugin = await ctx.plugins.setEnabled(pluginId, true);
    return { ok: true as const, plugin };
  });
  bb.implement(plugins.disable, async ({ pluginId }) => {
    const plugin = await ctx.plugins.setEnabled(pluginId, false);
    return { ok: true as const, plugin };
  });
  bb.implement(plugins.settings, async ({ pluginId }) => {
    const view = await ctx.plugins.settings(pluginId, undefined, actorUserId());
    return { ok: true as const, ...view };
  });
  bb.implement(plugins.updateSettings, async ({ pluginId, values }) => {
    const personal = ctx.plugins.hasPersonalSettings(
      pluginId,
      Object.keys(values),
    );
    if (!personal) requireOwner("Only the owner can manage plugins");
    const view = await ctx.plugins.settings(pluginId, values, actorUserId());
    return { ok: true as const, ...view };
  });
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
