import { contract, op } from "@bb/plugin";
import { z } from "zod";

export const sideChat = contract("side-chat", {
  create: op({
    input: z
      .object({
        sourceThreadId: z.string().trim().min(1),
        sourceSeqEnd: z.number().int().nonnegative().optional(),
        anchorText: z.string(),
      })
      .strict(),
    output: z.object({ threadId: z.string() }).strict(),
    kind: "write",
    doors: { http: { method: "POST", path: "/side-chat" } },
  }),
});
