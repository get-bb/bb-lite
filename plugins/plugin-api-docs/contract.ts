import { contract, op } from "@bb/plugin";
import { z } from "zod";

export const pluginApi = contract("plugin-api", {
  get: op({
    input: z.object({
      name: z
        .string()
        .optional()
        .describe("A contract, an operation, event or slot, or a search word"),
      plugin: z
        .string()
        .optional()
        .describe("A plugin id: print what it declares, implements and fills"),
    }),
    output: z.string(),
    doors: {
      cli: {
        path: "plugin-api",
        summary:
          "Print the loaded plugin API, one contract or member, or what a plugin uses",
        positionals: ["name"],
        print: (text) => text,
      },
    },
  }),
});
