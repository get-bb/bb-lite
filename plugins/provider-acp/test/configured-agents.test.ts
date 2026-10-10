import { describe, expect, it } from "vitest";
import { resolveConfiguredAcpAgents } from "../src/configured-agents.js";
import { acpProviderDeclaration } from "../src/declaration.js";
import {
  KNOWN_ACP_AGENTS,
  RESERVED_ACP_PROVIDER_IDS,
} from "../src/known-agents.js";

const reserved = RESERVED_ACP_PROVIDER_IDS;

function amp(displayName: string, command: string): unknown {
  return { id: "amp", displayName, command };
}

function shipped(id: string) {
  const agent = KNOWN_ACP_AGENTS.find((known) => known.id === id);
  if (agent === undefined) throw new Error(`no shipped agent ${id}`);
  return agent;
}

function onlyAgent(resolved: ReturnType<typeof resolveConfiguredAcpAgents>) {
  const [agent] = resolved.agents;
  if (agent === undefined || resolved.agents.length !== 1) {
    throw new Error(
      `expected exactly one agent, got ${resolved.agents.length}`,
    );
  }
  return agent;
}

describe("resolveConfiguredAcpAgents", () => {
  it("ignores a setting that is not JSON and says so", () => {
    const resolved = resolveConfiguredAcpAgents({
      settingValue: "[{ not json",
      reservedProviderIds: reserved,
      shippedAgents: KNOWN_ACP_AGENTS,
    });

    expect(resolved.agents).toEqual([]);
    expect(resolved.warnings).toHaveLength(1);
    expect(resolved.warnings[0]).toContain("not valid JSON");
  });

  it("reports a setting that is JSON but not an array", () => {
    const resolved = resolveConfiguredAcpAgents({
      settingValue: '{"id":"amp"}',
      reservedProviderIds: reserved,
      shippedAgents: KNOWN_ACP_AGENTS,
    });

    expect(resolved.agents).toEqual([]);
    expect(resolved.warnings[0]).toContain("must be a JSON array");
  });

  it("reports a reserved id and drops that entry", () => {
    const resolved = resolveConfiguredAcpAgents({
      settingValue: JSON.stringify([
        { id: "cursor", displayName: "Mine", command: "mine" },
      ]),
      reservedProviderIds: reserved,
      shippedAgents: KNOWN_ACP_AGENTS,
    });

    expect(resolved.agents).toEqual([]);
    expect(resolved.warnings).toHaveLength(1);
    expect(resolved.warnings[0]).toContain('built-in provider "acp-cursor"');
  });

  it("accepts an entry that overrides an installed-only known agent", () => {
    const resolved = resolveConfiguredAcpAgents({
      settingValue: JSON.stringify([
        { id: "opencode", displayName: "opencode", command: "/opt/opencode" },
      ]),
      reservedProviderIds: reserved,
      shippedAgents: KNOWN_ACP_AGENTS,
    });

    expect(resolved.agents.map((agent) => agent.id)).toEqual(["acp-opencode"]);
    expect(resolved.warnings).toEqual([]);
  });

  it("keeps an entry's native skill roots and declares them", () => {
    const resolved = resolveConfiguredAcpAgents({
      settingValue: JSON.stringify([
        {
          id: "amp",
          displayName: "Amp",
          command: "amp",
          nativeSkillRoots: { user: [".amp/skills"], project: [".amp"] },
        },
      ]),
      reservedProviderIds: reserved,
      shippedAgents: KNOWN_ACP_AGENTS,
    });

    const agent = onlyAgent(resolved);
    expect(resolved.warnings).toEqual([]);
    expect(agent.launch.nativeSkillRoots).toEqual({
      user: [".amp/skills"],
      project: [".amp"],
    });
    expect(acpProviderDeclaration(agent).nativeSkillRoots).toEqual({
      user: [".amp/skills"],
      project: [".amp"],
    });
  });
});

describe("a configured entry that replaces a shipped agent", () => {
  it("inherits the shipped agent's roots, with their options", () => {
    const resolved = resolveConfiguredAcpAgents({
      settingValue: JSON.stringify([
        { id: "grok", displayName: "Grok (private)", command: "/opt/grok" },
      ]),
      reservedProviderIds: reserved,
      shippedAgents: KNOWN_ACP_AGENTS,
    });
    const agent = onlyAgent(resolved);
    expect(resolved.warnings).toEqual([]);
    expect(agent.id).toBe("acp-grok");
    expect(agent.launch.command).toBe("/opt/grok");
    expect(agent.launch.nativeSkillRoots).toEqual(
      shipped("acp-grok").launch.nativeSkillRoots,
    );
  });

  it("gives a new id nothing to inherit", () => {
    const agent = onlyAgent(
      resolveConfiguredAcpAgents({
        settingValue: JSON.stringify([
          { id: "amp", displayName: "Amp", command: "amp" },
        ]),
        reservedProviderIds: reserved,
        shippedAgents: KNOWN_ACP_AGENTS,
      }),
    );
    expect(agent.launch.nativeSkillRoots).toBeUndefined();
  });
});
