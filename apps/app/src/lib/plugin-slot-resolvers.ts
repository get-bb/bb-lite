import type {
  PluginMessageDirectiveSlot,
  PluginPendingInteractionSlot,
} from "./plugin-slots";

export function resolvePendingInteraction(
  registrations: readonly PluginPendingInteractionSlot[],
  pluginId: string,
  rendererId: string,
): PluginPendingInteractionSlot | null {
  return (
    registrations.find(
      (registration) =>
        registration.pluginId === pluginId && registration.id === rendererId,
    ) ?? null
  );
}

export type ResolvedMessageDirective =
  | { status: "ok"; slot: PluginMessageDirectiveSlot }
  | { status: "collision"; pluginIds: readonly string[] };

function resolveMessageDirectiveClaimants(
  claimants: readonly PluginMessageDirectiveSlot[],
): ResolvedMessageDirective | null {
  if (claimants.length === 0) return null;
  const only = claimants[0];
  if (claimants.length === 1 && only !== undefined) {
    return { status: "ok", slot: only };
  }
  return {
    status: "collision",
    pluginIds: [
      ...new Set(claimants.map((claimant) => claimant.pluginId)),
    ].sort(),
  };
}

export function resolveMessageDirectiveRegistry(
  registrations: readonly PluginMessageDirectiveSlot[],
): ReadonlyMap<string, ResolvedMessageDirective> {
  const claimantsById = new Map<string, PluginMessageDirectiveSlot[]>();
  for (const registration of registrations) {
    const claimants = claimantsById.get(registration.id);
    if (claimants === undefined) {
      claimantsById.set(registration.id, [registration]);
    } else {
      claimants.push(registration);
    }
  }

  const resolved = new Map<string, ResolvedMessageDirective>();
  for (const [id, claimants] of claimantsById) {
    const directive = resolveMessageDirectiveClaimants(claimants);
    if (directive !== null) resolved.set(id, directive);
  }
  return resolved;
}

export type ResolvedReplacement<Registration> =
  | { kind: "owner" }
  | { kind: "plugin"; registration: Registration };

const OWNER_REPLACEMENT: ResolvedReplacement<never> = { kind: "owner" };

export function resolveReplacement<Registration>(
  registrations: readonly Registration[],
  applies?: (registration: Registration) => boolean,
): ResolvedReplacement<Registration> {
  const registration =
    applies === undefined
      ? registrations[0]
      : registrations.find((candidate) => applies(candidate));
  return registration === undefined
    ? OWNER_REPLACEMENT
    : { kind: "plugin", registration };
}
