import { contract, op, usageReadingSchema } from "@bb/plugin";
import { z } from "zod";

export const claudeCode = contract("provider-claude-code", {
  usage: op({
    input: z.object({}),
    output: usageReadingSchema,
    internal: true,
  }),
});
