import { contract, op } from "@bb/plugin";
import { z } from "zod";

export const echo = contract("echo", {
  echo: op({
    input: z.object({ text: z.string() }),
    output: z.object({ text: z.string(), calls: z.number() }),
    kind: "write",
  }),
  fail: op({ input: z.object({}), output: z.null() }),
  later: op({ input: z.object({}), output: z.null() }),
});
