import { contract, op } from "@bb/plugin";
import { z } from "zod";

export const MAX_SELECTED_HOSTS = 256;

export const hostSelection = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }).strict(),
  z
    .object({
      mode: z.literal("selected"),
      hostIds: z.array(z.string().min(1)).min(1).max(MAX_SELECTED_HOSTS),
    })
    .strict(),
]);

export const keepAwakeSettings = z
  .object({ enabled: z.boolean(), selection: hostSelection })
  .strict();

const configuration = keepAwakeSettings.extend({
  hosts: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      status: z.enum(["connected", "disconnected"]),
    }),
  ),
});

export type HostSelection = z.infer<typeof hostSelection>;
export type KeepAwakeSettings = z.infer<typeof keepAwakeSettings>;
export type KeepAwakeConfiguration = z.infer<typeof configuration>;

export const keepAwake = contract("keep-awake", {
  configuration: op({ input: z.object({}), output: configuration }),
  updateConfiguration: op({
    input: keepAwakeSettings,
    output: configuration,
    kind: "write",
    allow: "owner",
  }),
  updateMachine: op({
    input: z.object({ enabled: z.boolean() }).strict(),
    output: z.object({ enabled: z.boolean(), supported: z.boolean() }),
    kind: "write",
    audit: false,
    internal: true,
  }),
});
