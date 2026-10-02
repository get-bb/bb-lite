import { z } from "zod";

const UI_PREFERENCE_STRING_MAX_LENGTH = 1_024;

const providerIdSchema = z.string().min(1).max(UI_PREFERENCE_STRING_MAX_LENGTH);

function provider(defaultValue: string, legacy: string, current: string) {
  const schema = providerIdSchema.transform((value) =>
    value === legacy ? current : value,
  );
  return { schema, defaultValue };
}

export const uiPreferenceDefinitions = {
  "sidebar.navigationProvider": provider(
    "__automatic__",
    "__builtin__",
    "navigation/navigation",
  ),
  "sidebar.headerProvider": provider(
    "__builtin__",
    "__automatic__",
    "__builtin__",
  ),
  "sidebar.threadListProvider": provider(
    "__automatic__",
    "__builtin__",
    "thread-list/thread-list",
  ),
};

export type UiPreferenceKey = keyof typeof uiPreferenceDefinitions;
export const UI_PREFERENCE_KEYS = Object.keys(
  uiPreferenceDefinitions,
) as UiPreferenceKey[];

export function isUiPreferenceKey(value: string): value is UiPreferenceKey {
  return Object.hasOwn(uiPreferenceDefinitions, value);
}

export type UiPreferenceValue<Key extends UiPreferenceKey> = z.infer<
  (typeof uiPreferenceDefinitions)[Key]["schema"]
>;

export function getUiPreferenceDefault<Key extends UiPreferenceKey>(
  key: Key,
): UiPreferenceValue<Key> {
  return uiPreferenceDefinitions[key].defaultValue as UiPreferenceValue<Key>;
}

export type UiPreferenceParseResult<Key extends UiPreferenceKey> =
  | { success: true; value: UiPreferenceValue<Key> }
  | { success: false; message: string };

export function parseUiPreferenceValue<Key extends UiPreferenceKey>(
  key: Key,
  value: unknown,
): UiPreferenceParseResult<Key> {
  const schema: z.ZodTypeAny = uiPreferenceDefinitions[key].schema;
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return { success: true, value: parsed.data as UiPreferenceValue<Key> };
  }
  return {
    success: false,
    message: parsed.error.issues.map((issue) => issue.message).join("; "),
  };
}

export interface UiPreferenceEntry<
  Key extends UiPreferenceKey = UiPreferenceKey,
> {
  revision: number;
  value: UiPreferenceValue<Key>;
}

export type UiPreferenceEntries = {
  [Key in UiPreferenceKey]: UiPreferenceEntry<Key>;
};
