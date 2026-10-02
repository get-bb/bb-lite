import { defineRpcContract, type PluginServerApi } from "@bb/plugin";
import { z } from "zod";
import {
  PREFERENCE_DEFAULTS,
  PREFERENCE_KEYS,
  PREFERENCES_CHANGED_CHANNEL,
  preferenceKeySchema,
  preferenceSchemas,
  type PreferenceKey,
  type PreferenceValues,
} from "./shared/preferences.js";

const preferenceChangeSchema = z
  .object({ key: preferenceKeySchema, value: z.unknown() })
  .strict();

export const threadListRpcContract = defineRpcContract({
  listPreferences: {
    input: z.null(),
    output: z.object({ preferences: z.object(preferenceSchemas) }).strict(),
  },
  setPreference: {
    input: preferenceChangeSchema,
    output: preferenceChangeSchema,
  },
});

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

  bb.rpc.register(threadListRpcContract, {
    async listPreferences() {
      const entries = await Promise.all(
        PREFERENCE_KEYS.map(async (key) => [key, await read(key)] as const),
      );
      return { preferences: Object.fromEntries(entries) as PreferenceValues };
    },
    async setPreference({ key, value }) {
      const parsed: unknown = preferenceSchemas[key].parse(value);
      await bb.storage.kv.set(kvKey(key), parsed);
      const change = { key, value: parsed };
      bb.realtime.publish(PREFERENCES_CHANGED_CHANNEL, change);
      return change;
    },
  });
}
