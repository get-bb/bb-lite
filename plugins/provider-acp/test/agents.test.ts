import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  customAcpAgentDefinition,
  formatCustomAcpProviderId,
  parseCustomAcpAgents,
  runnerAgent,
  type CustomAcpAgent,
} from "../src/agents.js";
import { acpProviderDeclaration } from "../src/declaration.js";
import {
  KNOWN_ACP_AGENTS,
  RESERVED_ACP_PROVIDER_IDS,
} from "../src/known-agents.js";
import { REGISTRY_ICON_AGENT_IDS } from "../src/registry-icons.js";
import {
  acpLaunchSpecSchema,
  acpRunnerAgentSchema,
} from "../src/launch-spec.js";

const reserved = RESERVED_ACP_PROVIDER_IDS;

describe("parseCustomAcpAgents", () => {
  it("keeps a well-formed agent and defaults what it left out", () => {
    const parsed = parseCustomAcpAgents({
      entries: [{ id: "amp", displayName: "Amp", command: "amp" }],
      reservedProviderIds: reserved,
    });

    expect(parsed.problems).toEqual([]);
    expect(parsed.agents).toEqual([
      {
        id: "amp",
        displayName: "Amp",
        command: "amp",
        args: [],
        env: {},
        supportsManualCompaction: false,
      },
    ]);
  });

  it("reports a malformed entry, a shadowed built-in, and a duplicate", () => {
    const parsed = parseCustomAcpAgents({
      entries: [
        { id: "Bad Slug", displayName: "x", command: "x" },
        { id: "cursor", displayName: "Mine", command: "mine" },
        { id: "amp", displayName: "Amp", command: "amp" },
        { id: "amp", displayName: "Amp again", command: "amp" },
      ],
      reservedProviderIds: reserved,
    });

    expect(parsed.agents.map((agent) => agent.id)).toEqual(["amp"]);
    expect(parsed.problems).toHaveLength(3);
    expect(parsed.problems[1]).toContain(
      'resolves to built-in provider "acp-cursor"',
    );
    expect(parsed.problems[2]).toContain("configured more than once");
  });

  it("rejects the legacy logo field the setting never had", () => {
    const parsed = parseCustomAcpAgents({
      entries: [
        {
          id: "amp",
          displayName: "Amp",
          command: "amp",
          logo: "/home/user/amp.svg",
        },
      ],
      reservedProviderIds: reserved,
    });

    expect(parsed.agents).toEqual([]);
    expect(parsed.problems[0]).toContain("is not a valid agent");
  });

  it("only accepts entries whose launch spec the adapter will parse", () => {
    const parsed = parseCustomAcpAgents({
      entries: [
        {
          id: "amp",
          displayName: "Amp",
          command: "amp",
          args: ["acp"],
          env: { AMP_TOKEN: "x" },
          modelCli: { listArgs: ["--models"], primaryModels: ["amp-1"] },
          reasoningCli: {
            flag: "--effort",
            supportedLevels: ["low", "high"],
            levelValues: { low: "cheap", high: "deep" },
            defaultLevel: "high",
          },
          nativeReasoning: {
            configId: "effort",
            supportedLevels: ["medium"],
            levelValues: { medium: "balanced" },
          },
          nativeSkillRoots: { user: [".amp/skills"], project: [".amp"] },
          permissionCli: { full: ["--dangerous"] },
        },
      ],
      reservedProviderIds: reserved,
    });

    expect(parsed.problems).toEqual([]);
    const [agent] = parsed.agents;
    if (agent === undefined) throw new Error("expected the agent to parse");
    const launch = customAcpAgentDefinition(agent).launch;
    expect(acpLaunchSpecSchema.safeParse(launch).success).toBe(true);
    expect(launch.nativeSkillRoots).toEqual({
      user: [".amp/skills"],
      project: [".amp"],
    });
  });

  it.each([
    ["an absolute skill root", { nativeSkillRoots: { user: ["/etc/skills"] } }],
    [
      "an empty level id",
      { reasoningCli: { flag: "-e", supportedLevels: [""] } },
    ],
    [
      "a default level it does not support",
      {
        reasoningCli: {
          flag: "-e",
          supportedLevels: ["low"],
          defaultLevel: "high",
        },
      },
    ],
    ["an unknown skill-root shape", { nativeSkillRoots: { argFlag: "-s" } }],
  ])("rejects %s", (_label, extra) => {
    const parsed = parseCustomAcpAgents({
      entries: [{ id: "amp", displayName: "Amp", command: "amp", ...extra }],
      reservedProviderIds: reserved,
    });

    expect(parsed.agents).toEqual([]);
    expect(parsed.problems).toHaveLength(1);
  });
});

describe("custom agent icons", () => {
  const iconFor = (id: string) => {
    const [agent] = parseCustomAcpAgents({
      entries: [{ id, displayName: id, command: id }],
      reservedProviderIds: reserved,
    }).agents;
    if (agent === undefined) throw new Error(`agent ${id} did not parse`);
    return customAcpAgentDefinition(agent).icon;
  };

  it("gives an agent from the ACP registry its registry icon and any other agent the toolbox", () => {
    expect(iconFor("pi-acp")).toBe("registry-pi-acp");
    expect(iconFor("my-own-agent")).toBe("acp");
  });

  it("ships an icon file for every registry agent it names", () => {
    for (const agentId of REGISTRY_ICON_AGENT_IDS) {
      expect(
        existsSync(
          new URL(`../icons/registry-${agentId}.svg`, import.meta.url),
        ),
      ).toBe(true);
    }
  });
});

describe("customAcpAgentDefinition", () => {
  it("carries the launch spec and drops a model CLI with nothing to list", () => {
    const [agent] = parseCustomAcpAgents({
      entries: [
        {
          id: "amp",
          displayName: "Amp",
          command: "amp",
          args: ["acp"],
          env: { AMP_TOKEN: "x" },
          cwd: "/srv/amp",
          modelCli: { listArgs: [], primaryModels: [] },
          supportsManualCompaction: true,
        },
      ],
      reservedProviderIds: reserved,
    }).agents;
    if (agent === undefined) throw new Error("expected the agent to parse");
    const definition = customAcpAgentDefinition(agent);

    expect(definition.id).toBe(formatCustomAcpProviderId("amp"));
    expect(definition.launch).toEqual({
      displayName: "Amp",
      command: "amp",
      args: ["acp"],
      env: { AMP_TOKEN: "x" },
      cwd: "/srv/amp",
    });
    expect(definition.supportsManualCompaction).toBe(true);
    expect(definition.fork).toBe("none");
  });
});

describe("custom agents that report usage", () => {
  const parse = (entry: Record<string, unknown>) => {
    const [agent] = parseCustomAcpAgents({
      entries: [entry],
      reservedProviderIds: reserved,
    }).agents;
    if (agent === undefined) throw new Error("expected the agent to parse");
    return agent;
  };

  it("declares the usage capability when the entry asks for it", () => {
    const agent = parse({
      id: "cursor-pooled",
      displayName: "Cursor (pooled)",
      command: "cursor-route",
      args: ["acp"],
      dialect: "cursor",
      providerUsage: true,
    });

    expect(customAcpAgentDefinition(agent).providerUsage).toBe(true);
  });

  it("stays out of the usage surface by default", () => {
    const agent = parse({
      id: "amp-plain",
      displayName: "Amp",
      command: "amp",
      args: ["acp"],
    });

    expect(customAcpAgentDefinition(agent).providerUsage).toBeUndefined();
  });
});

describe("acpProviderDeclaration", () => {
  it("declares no skill roots for an agent that names none", () => {
    for (const agent of KNOWN_ACP_AGENTS) {
      if (agent.launch.nativeSkillRoots !== undefined) continue;
      expect(acpProviderDeclaration(agent).nativeSkillRoots).toBeUndefined();
    }
  });

  it("declares the static skill roots as plain paths", () => {
    const cursor = KNOWN_ACP_AGENTS.find((agent) => agent.id === "acp-cursor");
    if (cursor === undefined) throw new Error("expected Cursor");
    const roots = acpProviderDeclaration(cursor).nativeSkillRoots;
    expect(roots?.user).toContain(".claude/skills");
    expect(roots?.project).toContain(".cursor/skills");
  });

  it("offers both permission modes and the host model catalog", () => {
    for (const agent of KNOWN_ACP_AGENTS) {
      const declaration = acpProviderDeclaration(agent);
      expect(declaration.permissionModes).toEqual(["accept-edits", "full"]);
      expect(declaration.modelCatalogScope).toBe("host");
      expect(declaration.logo?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("keeps each agent's own reasoning ladder", () => {
    const levels = Object.fromEntries(
      KNOWN_ACP_AGENTS.map((agent) => [
        agent.id,
        acpProviderDeclaration(agent).reasoningLevels,
      ]),
    );
    expect(levels["acp-cursor"]).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(levels["acp-hermes-agent"]?.[0]).toBe("none");
  });

  it("gives a configured agent honest copy when it names no sign-in command", () => {
    const [agent] = parseCustomAcpAgents({
      entries: [{ id: "amp", displayName: "Amp", command: "amp" }],
      reservedProviderIds: reserved,
    }).agents;
    if (agent === undefined) throw new Error("expected the agent to parse");
    const strings = acpProviderDeclaration(customAcpAgentDefinition(agent))
      .optional.strings;
    expect(strings?.signInHint).toBe(
      "Sign in to Amp on the machine, then reload.",
    );
  });
});

describe("runnerAgent", () => {
  it("gives the runner part only the fields its schema has", () => {
    for (const agent of KNOWN_ACP_AGENTS) {
      expect(acpRunnerAgentSchema.parse(runnerAgent(agent)).id).toBe(agent.id);
    }
  });
});
