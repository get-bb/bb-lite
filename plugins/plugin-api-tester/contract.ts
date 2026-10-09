import { contract, op } from "@bb/plugin";
import { z } from "zod";

export const apiTester = contract("plugin-api-tester", {
  status: op({
    input: z.object({}),
    output: z.object({
      active: z.boolean(),
      pluginId: z.string(),
      door: z.string(),
    }),
    doors: {
      cli: {
        path: "api-tester status",
        summary: "Confirm that the Plugin API Tester is loaded",
      },
    },
  }),
});
