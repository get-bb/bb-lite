export const PLUGIN_MENTION_TRIGGER_VALUES = ["@", "#", "$", "!", "~"] as const;
export type PluginMentionTrigger =
  (typeof PLUGIN_MENTION_TRIGGER_VALUES)[number];

export const DEFAULT_PLUGIN_MENTION_TRIGGER: PluginMentionTrigger = "@";

export function normalizePluginMentionTriggers(
  value: unknown,
): readonly PluginMentionTrigger[] | null {
  if (value === undefined) return [DEFAULT_PLUGIN_MENTION_TRIGGER];
  const known: readonly unknown[] = PLUGIN_MENTION_TRIGGER_VALUES;
  const isValid =
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((trigger) => known.includes(trigger)) &&
    new Set(value).size === value.length;
  return isValid ? (value as PluginMentionTrigger[]) : null;
}
