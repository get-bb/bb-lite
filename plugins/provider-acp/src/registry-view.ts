import { z } from "zod";

export const registryAgentViewBaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  repository: z.string().nullable(),
  website: z.string().nullable(),
  authors: z.array(z.string()),
  license: z.string().nullable(),
  launch: z
    .object({
      kind: z.enum(["npx", "uvx"]),
      package: z.string(),
      args: z.array(z.string()),
      env: z.record(z.string(), z.string()),
    })
    .nullable(),
  binaryPlatforms: z.array(z.string()),
});

const registryAgentViewSchema = registryAgentViewBaseSchema.extend({
  providerId: z.string(),
  status: z.enum([
    "available",
    "added",
    "update-available",
    "built-in",
    "manual-install",
  ]),
  command: z.string().nullable(),
  icon: z.string().nullable(),
});

export const registryViewSchema = z.object({
  fetchedAt: z.number().nullable(),
  error: z.string().nullable(),
  agents: z.array(registryAgentViewSchema),
});
export type AcpRegistryView = z.infer<typeof registryViewSchema>;

const STATUS_LABELS: Record<
  AcpRegistryView["agents"][number]["status"],
  string
> = {
  available: "available",
  added: "added",
  "update-available": "update available",
  "built-in": "built in",
  "manual-install": "manual install",
};

export function formatRegistryView(view: AcpRegistryView): string {
  const lines = view.agents.map(
    (agent) =>
      `${agent.id}  ${agent.name} ${agent.version}  [${STATUS_LABELS[agent.status]}]${
        agent.description === "" ? "" : `  ${agent.description}`
      }`,
  );
  if (view.error !== null) {
    lines.push(
      view.agents.length === 0
        ? `Could not load the ACP registry: ${view.error}`
        : `Showing a saved copy; the ACP registry could not be reached: ${view.error}`,
    );
  } else if (lines.length === 0) {
    lines.push("The ACP registry lists no agents.");
  }
  return lines.join("\n");
}
