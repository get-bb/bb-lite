import { sessions, type MentionQuery, type PluginServerApi } from "@bb/plugin";
import type { PluginMentionGroup } from "@bb/server-contract";
import { notFound } from "@bb/server-kit/http/errors";

export async function searchMentions(
  bb: PluginServerApi,
  query: MentionQuery,
): Promise<PluginMentionGroup[]> {
  const groups: PluginMentionGroup[] = [];
  const sources = query.query === "" ? [] : bb.entries(sessions.mention);
  for (const { plugin: pluginId, item: provider } of sources) {
    if (!(provider.triggers ?? ["@"]).includes(query.trigger)) continue;
    const found = await Promise.resolve()
      .then(() => provider.search(query))
      .catch((err: unknown) => {
        bb.log.warn("A plugin's mention search failed", { pluginId, err });
        return [];
      });
    if (found.length === 0) continue;
    const items = found.map((item) => ({
      itemId: `${provider.id}:${item.id}`,
      title: item.title,
      subtitle: item.subtitle ?? null,
      icon: item.icon ?? null,
    }));
    const { id: providerId, label } = provider;
    groups.push({ pluginId, providerId, label, items });
  }
  return groups;
}

export async function resolveMention(
  bb: PluginServerApi,
  pluginId: string,
  itemId: string,
): Promise<string> {
  const [providerId, ...rest] = itemId.split(":");
  const found = bb
    .entries(sessions.mention)
    .find(({ plugin, item }) => plugin === pluginId && item.id === providerId);
  if (found === undefined) {
    throw notFound(`Unknown mention provider "${providerId}"`);
  }
  return (await found.item.resolve(rest.join(":"))).context;
}
