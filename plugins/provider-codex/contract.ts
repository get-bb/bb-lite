import { contract, op, usageReadingSchema } from "@bb/plugin";
import { z } from "zod";

export const codex = contract("provider-codex", {
  usage: op({
    input: z.object({}),
    output: usageReadingSchema,
    internal: true,
  }),
});
