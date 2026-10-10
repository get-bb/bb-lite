import { promptInputSchema } from "@bb/domain";
import { contract, op } from "@bb/plugin";
import { z } from "zod";

export const drafts = contract("drafts", {
  create: op({
    input: z
      .object({
        threadId: z.string().min(1),
        text: z.string().min(1).optional(),
        input: z.array(promptInputSchema).min(1).optional(),
      })
      .refine((value) => value.text !== undefined || value.input, {
        message: "Give text or input",
      }),
    output: z.object({ queuedMessageId: z.string() }),
    kind: "write",
  }),
});
