import { contract, op, usageReadingSchema } from "@bb/plugin";
import { z } from "zod";
import {
  acpAgentProbeSchema,
  acpRunnerAgentSchema,
} from "./src/launch-spec.js";

export const acpMachine = contract("provider-acp-machine", {
  configure: op({
    input: z.object({ agents: z.array(acpRunnerAgentSchema) }),
    output: z.object({ providerIds: z.array(z.string()) }),
    kind: "write",
    internal: true,
  }),
  probe: op({
    input: z.object({
      command: z.string().min(1),
      args: z.array(z.string()),
      env: z.record(z.string(), z.string()),
    }),
    output: acpAgentProbeSchema,
    internal: true,
  }),
  usage: op({
    input: z.object({ providerId: z.string().min(1) }),
    output: usageReadingSchema,
    internal: true,
  }),
});
