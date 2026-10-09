import { contract, op } from "@bb/plugin";
import { z } from "zod";

export const MAX_LIMIT_VALUE = 10_000;

const limit = z.number().int().min(0).max(MAX_LIMIT_VALUE);

export const configurationSchema = z
  .object({
    globalLimit: limit.nullable(),
    hostOverrides: z
      .array(z.object({ hostId: z.string().min(1).max(256), limit }).strict())
      .max(256)
      .refine(
        (overrides) =>
          new Set(overrides.map(({ hostId }) => hostId)).size ===
          overrides.length,
        "Duplicate host override",
      ),
  })
  .strict();
export type Configuration = z.infer<typeof configurationSchema>;

const hostLimitSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["connected", "disconnected"]),
  availableParallelism: z.number().int().positive().nullable(),
  automaticLimit: limit,
  effectiveLimit: limit,
  override: limit.nullable(),
});
export type HostLimit = z.infer<typeof hostLimitSchema>;

const viewSchema = configurationSchema.extend({
  hosts: z.array(hostLimitSchema),
});
export type LimitsView = z.infer<typeof viewSchema>;

export const concurrencyLimit = contract("concurrency-limit", {
  get: op({ input: z.object({}), output: viewSchema }),
  update: op({
    input: configurationSchema,
    output: viewSchema,
    kind: "write",
    allow: "owner",
  }),
  capacity: op({
    input: z.object({}),
    output: z.object({ availableParallelism: z.number().int().positive() }),
    internal: true,
  }),
});

export function parseLimitValue(raw: string): number | null {
  if (!/^\d+$/u.test(raw)) return null;
  const value = Number(raw);
  return value <= MAX_LIMIT_VALUE ? value : null;
}
