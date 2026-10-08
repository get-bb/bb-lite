import { z } from "zod";

const LIST_MAX_LENGTH = 10_000;
const stringListSchema = z
  .array(z.string().min(1).max(1_024))
  .max(LIST_MAX_LENGTH);

export const preferenceSchemas = {
  showProviderIcons: z.boolean(),
  threadLifecycles: z
    .array(z.enum(["active", "archived"]))
    .min(1)
    .max(2)
    .refine((value) => new Set(value).size === value.length),
  environmentGrouping: z.union([z.literal("auto"), z.boolean()]),
  chronologicalSort: z.enum(["updated", "created", "alpha", "none"]),
  sortDirection: z.enum(["default", "ascending", "descending"]),
  manualSectionOrder: stringListSchema,
  collapsedSections: z
    .array(z.enum(["pinned", "threads"]))
    .max(LIST_MAX_LENGTH),
  collapsedThreads: stringListSchema,
  collapsedEnvironments: stringListSchema,
  collapsedThreadSections: stringListSchema,
} as const;

export type PreferenceKey = keyof typeof preferenceSchemas;
export type PreferenceValues = {
  [Key in PreferenceKey]: z.infer<(typeof preferenceSchemas)[Key]>;
};

export const PREFERENCE_KEYS = Object.keys(
  preferenceSchemas,
) as PreferenceKey[];

export const preferenceKeySchema = z.enum(
  PREFERENCE_KEYS as [PreferenceKey, ...PreferenceKey[]],
);

export const PREFERENCE_DEFAULTS: PreferenceValues = {
  showProviderIcons: false,
  threadLifecycles: ["active"],
  environmentGrouping: "auto",
  chronologicalSort: "updated",
  sortDirection: "default",
  manualSectionOrder: ["pinned", "sections", "threads"],
  collapsedSections: [],
  collapsedThreads: [],
  collapsedEnvironments: [],
  collapsedThreadSections: [],
};

export function parsePreferences(source: unknown): Partial<PreferenceValues> {
  const values: Partial<Record<PreferenceKey, unknown>> = {};
  if (typeof source === "object" && source !== null) {
    for (const key of PREFERENCE_KEYS) {
      const parsed = preferenceSchemas[key].safeParse(Reflect.get(source, key));
      if (parsed.success) values[key] = parsed.data;
    }
  }
  return values as Partial<PreferenceValues>;
}
