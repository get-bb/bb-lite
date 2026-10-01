import { defineRpcContract } from "@bb/plugin";
import { z } from "zod";

export const contract = defineRpcContract({
  echo: {
    input: z.object({ text: z.string() }),
    output: z.object({ text: z.string(), calls: z.number() }),
  },
  fail: { input: z.null(), output: z.null() },
});
