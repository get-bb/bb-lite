import type { PromptInput } from "@bb/domain";
import { sessions, type PluginServerApi } from "@bb/plugin";

export async function resolvePluginMentions(
  bb: PluginServerApi,
  input: PromptInput[],
): Promise<PromptInput[]> {
  const seen = new Set<string>();
  const context: PromptInput[] = [];
  for (const part of input) {
    if (part.type !== "text") continue;
    for (const { resource } of part.mentions) {
      if (resource.kind !== "plugin") continue;
      const key = `${resource.pluginId}::${resource.itemId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const { pluginId, itemId, label } = resource;
      const resolved = await bb.call(sessions.resolveMention, {
        pluginId,
        itemId,
      });
      context.push({
        type: "text",
        text: `Context for @${label} (resolved by plugin "${pluginId}"):\n\n${resolved}`,
        mentions: [],
        visibility: "agent-only",
      });
    }
  }
  return context.length === 0 ? input : [...input, ...context];
}
