import { sessions, type PluginServerApi } from "@bb/plugin";

export async function generateTitle(
  bb: PluginServerApi,
  prompt: string,
  signal: AbortSignal,
): Promise<string | null> {
  const attempt = async (
    pluginId: string,
    run: () => Promise<string | null>,
  ) => {
    try {
      return await run();
    } catch (err) {
      bb.log.warn("A plugin's title service failed", { pluginId, err });
      return null;
    }
  };
  const services = bb.entries(sessions.inference);
  for (const { plugin: pluginId, item: service } of services) {
    const complete = () => service.complete(prompt, { signal });
    const text = await attempt(pluginId, complete);
    if (text !== null && text.trim() !== "") return text.trim();
  }
  const fallback = bb.pick(sessions.titleFallback);
  if (services.length > 0 || fallback === null) return null;
  return attempt("core", () => fallback(prompt, signal));
}
