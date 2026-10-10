import { fail, type PluginServerApi } from "@bb/plugin";
import { z } from "zod";
import { threadList } from "./shared/contract.js";
import {
  PREFERENCE_DEFAULTS,
  PREFERENCE_KEYS,
  preferenceSchemas,
  type PreferenceKey,
  type PreferenceValues,
} from "./shared/preferences.js";

function kvKey(key: PreferenceKey): string {
  return `preference:${key}`;
}

export default function threadListPlugin(bb: PluginServerApi) {
  async function read(key: PreferenceKey): Promise<unknown> {
    const stored = await bb.storage.kv.get<unknown>(kvKey(key));
    if (stored === undefined) return PREFERENCE_DEFAULTS[key];
    const parsed = preferenceSchemas[key].safeParse(stored);
    if (parsed.success) return parsed.data;
    bb.log.warn(`stored preference ${key} is invalid; using the default`);
    return PREFERENCE_DEFAULTS[key];
  }

  bb.implement(threadList.listPreferences, async () => {
    const entries = await Promise.all(
      PREFERENCE_KEYS.map(async (key) => [key, await read(key)] as const),
    );
    return { preferences: Object.fromEntries(entries) as PreferenceValues };
  });
  bb.implement(threadList.setPreference, async ({ key, value }) => {
    const result = preferenceSchemas[key].safeParse(value);
    if (!result.success) {
      fail("invalid", `${key}: ${z.prettifyError(result.error)}`);
    }
    const parsed: unknown = result.data;
    await bb.storage.kv.set(kvKey(key), parsed);
    bb.changed(threadList.listPreferences);
    return { key, value: parsed };
  });
}
