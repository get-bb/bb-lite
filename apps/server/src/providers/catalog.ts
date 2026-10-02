import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  disabledProviderIdsSchema,
  type PermissionMode,
  type ProviderComposerAction,
  type ProviderComposerCommand,
  type ProviderInfo,
  type ProviderOptionDescriptor,
  type ReasoningLevel,
} from "@bb/domain";
import type { ProviderId } from "@bb/runner";
import type { SystemProviderCatalogEntry } from "@bb/server-contract";
import type { Db } from "../db/index.js";
import {
  getAppSettings,
  readSetting,
  setAppSettings,
  writeSetting,
  type Setting,
} from "../db/settings.js";

export interface ProviderLogo {
  content: Buffer;
  hash: string;
}

export interface ProviderDefinition {
  id: ProviderId;
  info: ProviderInfo;
  pluginName: string;
  reasoningLevels: ReasoningLevel[];
  logo: ProviderLogo | null;
}

interface ProviderSeed extends Pick<
  ProviderInfo,
  "displayName" | "completedTurnDisplay"
> {
  id: ProviderId;
  logoFile: string | null;
  reasoningLevels: ReasoningLevel[];
  composerCommands: ("plan" | "goal")[];
  capabilities: Omit<
    ProviderInfo["capabilities"],
    "permissionModes" | "modelCatalogScope"
  >;
  optional: Pick<ProviderInfo, "strings" | "serviceTiers" | "extensionKinds">;
}

const PERMISSION_MODES: PermissionMode[] = ["accept-edits", "auto", "full"];
const LEVEL_LABELS: Record<ReasoningLevel, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  ultracode: "Ultracode",
  max: "Max",
  ultra: "Ultra",
};
const LEVEL_DESCRIPTIONS: Partial<Record<ReasoningLevel, string>> = {
  ultracode: "Extra-high effort plus standing workflow orchestration.",
  ultra: "Max effort plus automatic task delegation.",
};
const CLAUDE_FAST_TIER =
  "Faster responses on supported Opus models at a higher cost per token.";

const disabledProvidersSetting: Setting<string[]> = {
  key: "disabledProviderIds",
  schema: disabledProviderIdsSchema,
  fallback: [],
};

function loadLogo(file: string): ProviderLogo {
  const content = readFileSync(new URL(`./logos/${file}`, import.meta.url));
  const digest = createHash("sha256").update(content).digest("hex");
  return { content, hash: digest.slice(0, 16) };
}

function levelDescriptor(level: ReasoningLevel): ProviderOptionDescriptor {
  const description = LEVEL_DESCRIPTIONS[level];
  const descriptor = { id: level, label: LEVEL_LABELS[level] };
  return description === undefined
    ? descriptor
    : { ...descriptor, description };
}

function slashCommand(name: "plan" | "goal"): ProviderComposerAction {
  return { kind: name, command: { trigger: "/", name, trailingText: " " } };
}

function defineProvider(seed: ProviderSeed): ProviderDefinition {
  const { id, reasoningLevels } = seed;
  const logo = seed.logoFile === null ? null : loadLogo(seed.logoFile);
  const logoPath = `/api/v1/system/providers/${id}/logo`;
  const info: ProviderInfo = {
    id,
    pluginId: `provider-${id}`,
    displayName: seed.displayName,
    available: true,
    maintenance: { health: true, usage: true, installation: true },
    logoUrl: logo === null ? null : `${logoPath}?h=${logo.hash}`,
    capabilities: {
      ...seed.capabilities,
      permissionModes: PERMISSION_MODES,
      modelCatalogScope: "host",
    },
    composerActions: [
      { kind: "skills", trigger: "/" },
      { kind: "skills", trigger: "$" },
      ...seed.composerCommands.map(slashCommand),
    ],
    completedTurnDisplay: seed.completedTurnDisplay,
    reasoningLevels: reasoningLevels.map(levelDescriptor),
    ...seed.optional,
  };
  const pluginName = `${seed.displayName} provider`;
  return { id, info, pluginName, reasoningLevels, logo };
}

const CODEX = defineProvider({
  id: "codex",
  displayName: "Codex",
  logoFile: "codex.svg",
  completedTurnDisplay: "collapse",
  reasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
  composerCommands: ["plan", "goal"],
  capabilities: {
    supportsThreadArchive: true,
    supportsThreadRename: true,
    supportsServiceTier: true,
    supportsNativeUserQuestion: false,
    supportsFork: true,
    supportsSessionRewind: true,
  },
  optional: {
    strings: {
      signInHint: "Run `codex` on the machine to sign in.",
      expiredHint: "Your Codex session expired. Run `codex`, then reload.",
      installUrl: "https://developers.openai.com/codex/cli",
      brandPrefix: "GPT-",
    },
    serviceTiers: [
      { id: "default", label: "Default" },
      { id: "fast", label: "Fast" },
    ],
    extensionKinds: {
      "provider-codex/goal": { item: false, state: true },
      "provider-codex/macos-permission": { item: true, state: false },
    },
  },
});

const CLAUDE_CODE = defineProvider({
  id: "claude-code",
  displayName: "Claude Code",
  logoFile: "claude-code.svg",
  completedTurnDisplay: "flat",
  reasoningLevels: ["low", "medium", "high", "xhigh", "ultracode", "max"],
  composerCommands: ["plan"],
  capabilities: {
    supportsThreadArchive: false,
    supportsThreadRename: false,
    supportsServiceTier: true,
    supportsNativeUserQuestion: true,
    supportsFork: true,
    supportsSessionRewind: true,
  },
  optional: {
    strings: {
      signInHint: "Run `claude` on the machine to sign in.",
      expiredHint: "Your Claude session expired. Run `claude`, then reload.",
      installUrl: "https://claude.com/claude-code",
      brandPrefix: "Claude ",
      planModeCopy:
        "Claude Code will plan without normal full-access execution.",
      iconTint: { light: "#D97757", dark: "#D97757" },
    },
    serviceTiers: [
      { id: "default", label: "Default" },
      { id: "fast", label: "Fast", description: CLAUDE_FAST_TIER },
    ],
  },
});

const ECHO = defineProvider({
  id: "echo",
  displayName: "Echo",
  logoFile: null,
  completedTurnDisplay: "collapse",
  reasoningLevels: ["low", "medium", "high"],
  composerCommands: [],
  capabilities: {
    supportsThreadArchive: false,
    supportsThreadRename: false,
    supportsServiceTier: false,
    supportsNativeUserQuestion: false,
    supportsFork: false,
    supportsSessionRewind: false,
  },
  optional: {},
});

function devProviderEnabled(id: string, env = process.env): boolean {
  if (env.VITEST === "true") return true;
  return (env.BB_DEV_PROVIDERS ?? "").split(",").includes(id);
}

export function listProviderDefinitions(db: Db): ProviderDefinition[] {
  const { providerOrder } = getAppSettings(db);
  const rank = ({ id }: ProviderDefinition): number => {
    const index = providerOrder.indexOf(id);
    return index < 0 ? providerOrder.length : index;
  };
  const providers = [CODEX, CLAUDE_CODE];
  if (devProviderEnabled(ECHO.id)) providers.push(ECHO);
  return providers.sort((left, right) => rank(left) - rank(right));
}

export function findProviderDefinition(
  db: Db,
  providerId: string,
): ProviderDefinition | undefined {
  return listProviderDefinitions(db).find(({ id }) => id === providerId);
}

export function providerPlanCommand(
  db: Db,
  providerId: string,
): ProviderComposerCommand | null {
  const actions = findProviderDefinition(db, providerId)?.info.composerActions;
  const plan = actions?.find((action) => action.kind === "plan");
  return plan?.kind === "plan" ? plan.command : null;
}

export function listEnabledProviders(db: Db): ProviderDefinition[] {
  const disabled = readSetting(db, disabledProvidersSetting);
  return listProviderDefinitions(db).filter(({ id }) => !disabled.includes(id));
}

export function listProviderCatalog(db: Db): SystemProviderCatalogEntry[] {
  const disabled = readSetting(db, disabledProvidersSetting);
  return listProviderDefinitions(db).map(({ id, info, pluginName }) => ({
    id,
    displayName: info.displayName,
    pluginId: info.pluginId,
    pluginName,
    pluginEnabled: true,
    enabled: !disabled.includes(id),
    available: info.available,
    logoUrl: info.logoUrl,
    info,
  }));
}

export function setProviderEnabled(
  db: Db,
  providerId: string,
  enabled: boolean,
): void {
  const others = readSetting(db, disabledProvidersSetting).filter(
    (id) => id !== providerId,
  );
  const disabled = enabled ? others : [...others, providerId];
  writeSetting(db, disabledProvidersSetting, disabled);
  const settings = getAppSettings(db);
  if (!enabled && settings.defaultProviderId === providerId) {
    setAppSettings(db, { ...settings, defaultProviderId: null });
  }
}
