import { contract, op } from "@bb/plugin";
import { z } from "zod";

export const configuration = z.object({ enabled: z.boolean() });

export const napGuard = contract("nap-guard", {
  configuration: op({
    input: z.object({}),
    output: configuration,
    doors: { cli: { path: "nap-guard config", summary: "Show the state" } },
  }),
  updateConfiguration: op({
    input: configuration,
    output: configuration,
    kind: "write",
    allow: "owner",
  }),
});
