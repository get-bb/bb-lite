import { contract, live, op } from "@bb/plugin";
import { z } from "zod";

export const sweepname = contract("sweepname", {
  greet: op({
    input: z.object({ name: z.string().describe("Who to greet") }),
    output: z.string(),
    kind: "write",
    doors: {
      cli: {
        path: "sweepname greet",
        summary: "Greet someone",
        description: "Prints a greeting and counts it.",
        positionals: ["name"],
      },
      agent: {
        name: "SweepnameGreet",
        description: "Greet someone by name.",
      },
    },
  }),
  greetings: live(z.number()),
});
