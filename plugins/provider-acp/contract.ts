import { contract, op, usageReadingSchema } from "@bb/plugin";
import { z } from "zod";
import { formatRegistryView, registryViewSchema } from "./src/registry-view.js";
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

const agentId = z.object({ id: z.string().min(1) });
const STATUS_HINT = "Run `bb acp registry` to see the agents and their ids.";

export const acp = contract("provider-acp", {
  registry: op({
    input: z.object({ refresh: z.boolean().default(false) }),
    output: registryViewSchema,
    doors: {
      http: { method: "GET", path: "/acp/registry" },
      cli: {
        path: "acp registry",
        summary: "List the ACP registry's agents and whether each is added",
        description:
          "Lists the agents in the Agent Client Protocol registry. Pass " +
          "--refresh to fetch the registry again instead of the saved copy.",
        print: formatRegistryView,
      },
    },
  }),
  add: op({
    input: agentId,
    output: registryViewSchema,
    kind: "write",
    doors: {
      http: { method: "POST", path: "/acp/agents" },
      cli: {
        path: "acp add",
        summary:
          "Add a registry agent as a bb provider, or move an added one to " +
          "the registry's current version",
        description: STATUS_HINT,
        positionals: [{ field: "id", name: "agent-id" }],
        print: (view, { id }) => {
          const added = view.agents.find((agent) => agent.id === id);
          return added === undefined
            ? `Added ${id}`
            : `Added ${added.name} ${added.version} as provider ` +
                `${added.providerId}\nRuns: ${added.command ?? ""}`;
        },
      },
    },
  }),
  remove: op({
    input: agentId,
    output: registryViewSchema,
    kind: "write",
    doors: {
      http: { method: "DELETE", path: "/acp/agents/:id" },
      cli: {
        path: "acp remove",
        summary: "Remove an agent that was added from the registry or by hand",
        description: STATUS_HINT,
        positionals: [{ field: "id", name: "agent-id" }],
        print: (_view, { id }) => `Removed ${id}`,
      },
    },
  }),
});
