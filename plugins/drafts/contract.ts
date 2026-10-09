import { contract, op } from "@bb/plugin";
import { z } from "zod";

export const drafts = contract("drafts", {
  create: op({
    input: z.object({ threadId: z.string().min(1), text: z.string().min(1) }),
    output: z.object({ queuedMessageId: z.string() }),
    kind: "write",
  }),
});
