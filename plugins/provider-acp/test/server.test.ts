import { afterAll, beforeAll, expect, it } from "vitest";
import { createThreadServer } from "../../../apps/server/test/thread-harness.js";
import { REGISTRY_URL_ENV } from "../src/registry-service.js";

type Call = { name: string; input: unknown };

const fixture = new URL("./fixtures/registry.json", import.meta.url).href;
let previousUrl: string | undefined;

beforeAll(() => {
  previousUrl = process.env[REGISTRY_URL_ENV];
  process.env[REGISTRY_URL_ENV] = fixture;
});

afterAll(() => {
  if (previousUrl === undefined) delete process.env[REGISTRY_URL_ENV];
  else process.env[REGISTRY_URL_ENV] = previousUrl;
});

async function acpServer(
  options: { reachable?: string[]; fork?: boolean } = {},
) {
  const server = await createThreadServer();
  const calls: Call[] = [];
  const previous = server.runner.script.callOp;
  server.runner.script.callOp = async (op) => {
    if (!op.name.startsWith("provider-acp-machine.")) return previous?.(op);
    calls.push({ name: op.name, input: op.input });
    if (op.name.endsWith(".configure")) return { providerIds: [] };
    if (op.name.endsWith(".usage")) {
      return { status: "ok", windows: [] };
    }
    const { command } = op.input as { command: string };
    return (options.reachable ?? []).includes(command)
      ? { reachable: true, fork: options.fork ?? true }
      : { reachable: false, reason: "not found" };
  };
  const op = async (name: string, input: unknown = {}) => {
    const { status, body } = await server.http<{ result?: unknown }>(
      "POST",
      `/ops/${name}`,
      input,
    );
    if (status >= 400) throw new Error(JSON.stringify(body));
    return body.result;
  };
  await op("plugins.disable", { pluginId: "provider-acp" });
  await op("plugins.enable", { pluginId: "provider-acp" });
  const providerIds = async () => {
    const { body } = await server.http<{ id: string }[]>(
      "GET",
      "/sessions/providers",
    );
    return body
      .map((provider) => provider.id)
      .filter((id) => id.startsWith("acp-"));
  };
  const configured = () =>
    calls
      .filter((call) => call.name.endsWith(".configure"))
      .map((call) =>
        (call.input as { agents: { id: string }[] }).agents.map(
          (agent) => agent.id,
        ),
      );
  const settle = async (check: () => Promise<boolean> | boolean) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("timed out");
  };
  return { ...server, calls, op, providerIds, configured, settle };
}

it("lists Cursor and keeps installed-only agents hidden until found", async () => {
  const server = await acpServer();
  await server.settle(() => server.configured().length > 0);
  expect(await server.providerIds()).toEqual(["acp-cursor"]);
  expect(server.configured()[0]).toEqual([
    "acp-cursor",
    "acp-opencode",
    "acp-omp",
    "acp-grok",
    "acp-hermes-agent",
  ]);
});

it("shows an installed-only agent once its command is found", async () => {
  const server = await acpServer({ reachable: ["opencode"] });
  await server.settle(async () =>
    (await server.providerIds()).includes("acp-opencode"),
  );
  expect(await server.providerIds()).toEqual(["acp-cursor", "acp-opencode"]);
});

it("downgrades a declared fork the agent does not advertise", async () => {
  const server = await acpServer({ reachable: ["opencode"], fork: false });
  await server.settle(() => server.configured().length > 1);
  const last = server.calls
    .filter((call) => call.name.endsWith(".configure"))
    .at(-1)?.input as { agents: { id: string; fork?: string }[] };
  expect(last.agents.find((agent) => agent.id === "acp-opencode")?.fork).toBe(
    "none",
  );
});

it("adds and removes a registry agent through the setting", async () => {
  const server = await acpServer();
  await server.settle(() => server.configured().length > 0);
  const view = (await server.op("provider-acp.registry", {})) as {
    agents: { id: string; status: string }[];
  };
  expect(view.agents.map((agent) => [agent.id, agent.status])).toEqual([
    ["amp-acp", "available"],
    ["grok-build", "built-in"],
  ]);
  await server.op("provider-acp.add", { id: "amp-acp" });
  await server.settle(async () =>
    (await server.providerIds()).includes("acp-amp-acp"),
  );
  expect(server.configured().at(-1)).toContain("acp-amp-acp");
  await expect(server.op("provider-acp.add", { id: "nope" })).rejects.toThrow(
    /has no agent/,
  );
  await server.op("provider-acp.remove", { id: "amp-acp" });
  await server.settle(
    async () => !(await server.providerIds()).includes("acp-amp-acp"),
  );
});

it("warns about a custom agent it cannot use and keeps the rest", async () => {
  const server = await acpServer();
  await server.settle(() => server.configured().length > 0);
  await server.op("plugins.updateSettings", {
    pluginId: "provider-acp",
    values: {
      customAgents: JSON.stringify([
        { id: "cursor", displayName: "Mine", command: "x" },
        { id: "mine", displayName: "Mine", command: "mine-acp" },
      ]),
    },
  });
  await server.settle(async () =>
    (await server.providerIds()).includes("acp-mine"),
  );
  expect(await server.providerIds()).toEqual(["acp-cursor", "acp-mine"]);
});

it("adds a usage source for the agents that report usage", async () => {
  const server = await acpServer();
  await server.settle(() => server.configured().length > 0);
  const { body } = await server.http<
    { id: string; maintenance: { usage: boolean } }[]
  >("GET", "/sessions/providers");
  const cursor = body.find((provider) => provider.id === "acp-cursor");
  expect(cursor?.maintenance.usage).toBe(true);
});

it("prints the registry through the bb acp CLI", async () => {
  const server = await acpServer();
  const { body } = await server.http<{ exitCode: number; stdout: string }>(
    "POST",
    "/plugins/provider-acp/cli",
    { argv: ["registry"] },
  );
  expect(body.stdout).toContain("amp-acp  Amp 0.7.0  [available]");
});

it("starts a thread in a permission mode the agent has when the default is not one of them", async () => {
  const server = await acpServer();
  await server.settle(() => server.configured().length > 0);
  await server.spawn({ providerId: "acp-cursor", model: "acp-default" });
  expect(server.submitted.at(-1)?.options.permissionMode).toBe("full");

  await server.spawn({
    providerId: "acp-cursor",
    model: "acp-default",
    permissionMode: "accept-edits",
  });
  expect(server.submitted.at(-1)?.options.permissionMode).toBe("accept-edits");
});
