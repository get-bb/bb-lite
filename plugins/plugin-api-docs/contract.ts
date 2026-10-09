import { contract, op } from "@bb/plugin";
import { z } from "zod";

export type MemberType = "op" | "event" | "slot" | "live";

export interface ApiMember {
  name: string;
  type: MemberType;
  facts: { label: string; value: string }[];
  shapes: { label: string; shape: unknown }[];
}

export interface ApiContract {
  name: string;
  members: ApiMember[];
}

export interface ApiReference {
  api: string;
  plugins: string[];
  contracts: ApiContract[];
}

export const pluginApi = contract("plugin-api", {
  list: op({
    input: z.object({}),
    output: z.custom<ApiReference>(),
  }),
  get: op({
    input: z.object({
      name: z
        .string()
        .optional()
        .describe("A contract, an operation, event or slot, or a search word"),
    }),
    output: z.string(),
    doors: {
      cli: {
        path: "plugin-api",
        summary: "Print the loaded plugin API, or one contract or member",
        positionals: ["name"],
        print: (text) => text,
      },
    },
  }),
});
