export const PLUGIN_MENTION_TRIGGER_VALUES = ["@", "#", "$", "!", "~"] as const;
export type PluginMentionTrigger =
  (typeof PLUGIN_MENTION_TRIGGER_VALUES)[number];

export const DEFAULT_PLUGIN_MENTION_TRIGGER: PluginMentionTrigger = "@";
