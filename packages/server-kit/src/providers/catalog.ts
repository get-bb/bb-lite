import { createHash } from "node:crypto";
import * as domain from "@bb/domain";
import { sessions, type Kernel, type ProviderDeclaration } from "@bb/plugin";
import type { SystemProviderCatalogEntry } from "@bb/server-contract";
import type { Db } from "../db/index.js";
import * as store from "../db/settings.js";

export interface ProviderLogo {
  content: Buffer;
  hash: string;
}

export interface ProviderDefinition {
  id: string;
  info: domain.ProviderInfo;
  pluginName: string;
  reasoningLevels: domain.ReasoningLevel[];
  logo: ProviderLogo | null;
}

const PERMISSION_MODES: domain.PermissionMode[] = [
  "accept-edits",
  "auto",
  "full",
];
const LEVEL_LABELS: Record<domain.ReasoningLevel, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  ultracode: "Ultracode",
  max: "Max",
  ultra: "Ultra",
};
const LEVEL_DESCRIPTIONS: Partial<Record<domain.ReasoningLevel, string>> = {
  ultracode: "Extra-high effort plus standing workflow orchestration.",
  ultra: "Max effort plus automatic task delegation.",
};

const disabledProvidersSetting: store.Setting<string[]> = {
  key: "disabledProviderIds",
  schema: domain.disabledProviderIdsSchema,
  fallback: [],
};

const kernels = new WeakMap<Db, Kernel>();
const defined = new WeakMap<ProviderDeclaration, ProviderDefinition>();

export function bindProviderCatalog(db: Db, kernel: Kernel): void {
  kernels.set(db, kernel);
}

export function providerDeclarations(db: Db): ProviderDeclaration[] {
  return kernels.get(db)?.read(sessions.provider) ?? [];
}

function loadLogo(content: Uint8Array): ProviderLogo {
  const digest = createHash("sha256").update(content).digest("hex");
  return { content: Buffer.from(content), hash: digest.slice(0, 16) };
}

function levelDescriptor(
  level: domain.ReasoningLevel,
): domain.ProviderOptionDescriptor {
  const description = LEVEL_DESCRIPTIONS[level];
  const descriptor = { id: level, label: LEVEL_LABELS[level] };
  return description === undefined
    ? descriptor
    : { ...descriptor, description };
}

function slashCommand(name: "goal"): domain.ProviderComposerAction {
  return { kind: name, command: { trigger: "/", name, trailingText: " " } };
}

function defineProvider(seed: ProviderDeclaration): ProviderDefinition {
  const known = defined.get(seed);
  if (known !== undefined) return known;
  const { id, reasoningLevels } = seed;
  const logo = seed.logo === null ? null : loadLogo(seed.logo);
  const logoPath = `/api/v1/system/providers/${id}/logo`;
  const info: domain.ProviderInfo = {
    id,
    pluginId: `provider-${id}`,
    displayName: seed.displayName,
    available: true,
    maintenance: { health: true, usage: true, installation: true },
    logoUrl: logo === null ? null : `${logoPath}?h=${logo.hash}`,
    capabilities: {
      ...seed.capabilities,
      permissionModes: seed.permissionModes ?? PERMISSION_MODES,
      modelCatalogScope: seed.modelCatalogScope ?? "host",
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
  const definition = { id, info, pluginName, reasoningLevels, logo };
  defined.set(seed, definition);
  return definition;
}

export function listProviderDefinitions(db: Db): ProviderDefinition[] {
  const { providerOrder } = store.getAppSettings(db);
  const rank = ({ id }: ProviderDefinition) => {
    const index = providerOrder.indexOf(id);
    return index < 0 ? providerOrder.length : index;
  };
  const providers = providerDeclarations(db).map(defineProvider);
  return providers.sort((left, right) => rank(left) - rank(right));
}

export function findProviderDefinition(
  db: Db,
  providerId: string,
): ProviderDefinition | undefined {
  return listProviderDefinitions(db).find(({ id }) => id === providerId);
}

export function listEnabledProviders(db: Db): ProviderDefinition[] {
  const disabled = store.readSetting(db, disabledProvidersSetting);
  return listProviderDefinitions(db).filter(({ id }) => !disabled.includes(id));
}

export function listProviderCatalog(db: Db): SystemProviderCatalogEntry[] {
  const disabled = store.readSetting(db, disabledProvidersSetting);
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
  const others = store
    .readSetting(db, disabledProvidersSetting)
    .filter((id) => id !== providerId);
  const disabled = enabled ? others : [...others, providerId];
  store.writeSetting(db, disabledProvidersSetting, disabled);
  const settings = store.getAppSettings(db);
  if (!enabled && settings.defaultProviderId === providerId) {
    store.setAppSettings(db, { ...settings, defaultProviderId: null });
  }
}
