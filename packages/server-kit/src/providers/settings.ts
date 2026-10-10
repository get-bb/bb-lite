import type { Db } from "../db/index.js";
import { readPluginRows } from "../db/plugins.js";
import { providerDeclarations } from "./catalog.js";

export function providerOptionsFor(
  db: Db,
  providerId: string,
): Record<string, unknown> {
  const declared = providerDeclarations(db).find(({ id }) => id === providerId);
  const toggles = Object.entries(declared?.settings ?? {});
  const pluginId = `provider-${providerId}`;
  const stored = readPluginRows(db, "plugin_settings", pluginId);
  return Object.fromEntries(
    toggles.map(([key, toggle]) => {
      const saved: unknown = JSON.parse(stored.get(key) ?? "null");
      const enabled = typeof saved === "boolean" ? saved : toggle.default;
      return [toggle.option, toggle.inverted === true ? !enabled : enabled];
    }),
  );
}
