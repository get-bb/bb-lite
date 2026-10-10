import { contract, op } from "@bb/plugin";
import { z } from "zod";
import { preferenceKeySchema, preferenceSchemas } from "./preferences.js";

const preferenceChangeSchema = z
  .object({ key: preferenceKeySchema, value: z.unknown() })
  .strict();

export const threadList = contract("thread-list", {
  listPreferences: op({
    input: z.object({}),
    output: z.object({ preferences: z.object(preferenceSchemas) }).strict(),
  }),
  setPreference: op({
    input: preferenceChangeSchema,
    output: preferenceChangeSchema,
    kind: "write",
  }),
});
