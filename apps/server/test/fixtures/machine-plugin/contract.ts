import { contract, op } from "@bb/plugin";
import { z } from "zod";

const answer = z.object({ dataDir: z.string(), sum: z.number() });

export const probe = contract("machine-probe", {
  where: op({ input: z.object({ hostId: z.string() }), output: answer }),
  sum: op({
    input: z.object({ a: z.number(), b: z.number() }),
    output: answer,
  }),
});
