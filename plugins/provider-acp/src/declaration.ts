import { existsSync, readFileSync } from "node:fs";
import type { ProviderDeclaration } from "@bb/plugin";
import type { AcpAgentDefinition } from "./agents.js";
import { nativeRootPath } from "./launch-spec.js";

const ACP_REASONING_LEVELS: ProviderDeclaration["reasoningLevels"] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const FALLBACK_ICON = "acp";

export function iconFile(name: string): URL {
  return new URL(`../icons/${name}.svg`, import.meta.url);
}

export function iconBytes(name: string | undefined): Uint8Array {
  const file = iconFile(name ?? FALLBACK_ICON);
  return readFileSync(existsSync(file) ? file : iconFile(FALLBACK_ICON));
}

function acpStrings(
  agent: AcpAgentDefinition,
): NonNullable<ProviderDeclaration["optional"]["strings"]> {
  const signIn = agent.signInCommand;
  return {
    signInHint:
      signIn === undefined
        ? `Sign in to ${agent.displayName} on the machine, then reload.`
        : `Run \`${signIn}\` on the machine to sign in.`,
    expiredHint:
      signIn === undefined
        ? `Your ${agent.displayName} session expired. Sign in on the ` +
          "machine, then reload."
        : `Your ${agent.displayName} session expired. Run \`${signIn}\`, ` +
          "then reload.",
    installUrl: agent.installUrl ?? "https://agentclientprotocol.com",
    ...(agent.iconTint === undefined ? {} : { iconTint: agent.iconTint }),
  };
}

export function acpProviderDeclaration(
  agent: AcpAgentDefinition,
): ProviderDeclaration {
  const roots = agent.launch.nativeSkillRoots;
  return {
    id: agent.id,
    displayName: agent.displayName,
    completedTurnDisplay: "flat",
    logo: iconBytes(agent.icon),
    reasoningLevels:
      agent.reasoningLevels === undefined
        ? [...ACP_REASONING_LEVELS]
        : [...agent.reasoningLevels],
    composerCommands: [],
    capabilities: {
      supportsThreadArchive: false,
      supportsThreadRename: false,
      supportsServiceTier: true,
      supportsNativeUserQuestion: false,
      supportsSessionRewind: false,
    },
    optional: {
      strings: acpStrings(agent),
      serviceTiers: [
        { id: "default", label: "Default" },
        { id: "fast", label: "Fast" },
      ],
    },
    permissionModes: ["accept-edits", "full"],
    modelCatalogScope: "host",
    ...(roots === undefined
      ? {}
      : {
          nativeSkillRoots: {
            user: roots.user.map(nativeRootPath),
            project: roots.project.map(nativeRootPath),
          },
        }),
  };
}
