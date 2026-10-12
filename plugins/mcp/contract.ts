import { contract, op } from "@bb/plugin";
import { z } from "zod";

const none = z.object({}).strict();

const statusSchema = z.object({
  remoteUrl: z.string().nullable(),
  localUrl: z.string(),
  remoteProblem: z.string().nullable(),
});
export type McpStatus = z.infer<typeof statusSchema>;

const grantSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  clientName: z.string(),
  scope: z.string(),
  createdAt: z.number(),
  lastUsedAt: z.number().nullable(),
});
export type McpGrant = z.infer<typeof grantSchema>;

const revokedSchema = z.object({
  revoked: z.literal(true),
  grantId: z.string(),
});

function printStatus({ remoteUrl, localUrl, remoteProblem }: McpStatus) {
  const remote =
    remoteUrl === null
      ? `Remote: unavailable (${remoteProblem ?? "turn on bb connect"})`
      : `Remote: ${remoteUrl}`;
  return [
    remote,
    `Local:  ${localUrl}`,
    "Add the remote address as a custom connector in ChatGPT or Claude; you approve access on a bb account page.",
  ].join("\n");
}

function printGrant(grant: McpGrant): string {
  const connected = new Date(grant.createdAt).toISOString();
  const lastUsed =
    grant.lastUsedAt === null
      ? "never used"
      : `last used ${new Date(grant.lastUsedAt).toISOString()}`;
  return `${grant.id}  ${grant.clientName}  connected ${connected}  ${lastUsed}`;
}

function printGrants(grants: McpGrant[]): string {
  if (grants.length === 0) return "No remote apps are connected.";
  return grants.map(printGrant).join("\n");
}

export const mcp = contract("mcp", {
  status: op({
    input: none,
    output: statusSchema,
    description: "The addresses MCP clients use to reach this bb",
    doors: {
      cli: {
        path: "mcp status",
        summary: "Show the MCP addresses for this bb",
        description:
          "While this plugin is enabled, bb serves a Model Context Protocol endpoint. Remote apps sign in through your bb account and reach it at your bb connect address; apps on this machine can use the local address directly.",
        print: printStatus,
      },
    },
  }),
  clients: op({
    input: none,
    output: z.array(grantSchema),
    allow: "owner",
    description: "The remote apps approved to reach this bb over MCP",
    doors: {
      cli: {
        path: "mcp clients",
        summary: "List the remote apps that can reach this bb over MCP",
        print: printGrants,
      },
    },
  }),
  revoke: op({
    input: z.object({
      grantId: z.string().min(1).describe("The id `bb mcp clients` prints"),
    }),
    output: revokedSchema,
    kind: "write",
    allow: "owner",
    description: "Disconnect a remote app",
    doors: {
      cli: {
        path: "mcp revoke",
        summary: "Disconnect a remote app",
        positionals: ["grantId"],
        print: ({ grantId }) =>
          `Disconnected ${grantId}. The app loses access within about a minute.`,
      },
    },
  }),
});
