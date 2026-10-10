import { machineRemovalLabels } from "./machine-removal-display";
import type { Host } from "@bb/domain";
import type { EnvironmentDisplayInfo } from "@bb/core-ui";
import type { SystemEnvironmentProvider } from "@bb/server-contract";
import type { IconName } from "@bb/shared-ui/icon";
import { pluginIconName } from "../components/plugin/PluginIcon";

type ProviderLookup =
  | { status: "loading" }
  | {
      status: "loaded";
      provider: SystemEnvironmentProvider | null;
      environmentProviderId: string | null;
    };

type SummaryHost = Pick<Host, "name" | "type">;

interface LabelArgs {
  display: EnvironmentDisplayInfo;
  providerLookup: ProviderLookup;
}

export const UNNAMED_ENVIRONMENT_LABEL = "Environment";
export const REUSE_ENVIRONMENT_ICON_NAME: IconName = "Folder02";

export function isHostAmbiguous(
  hasMultipleMachines: boolean,
  hostType: Host["type"] | null,
): boolean {
  return hasMultipleMachines || hostType !== "persistent";
}

export function findEnvironmentDisplayProvider(
  providers: readonly SystemEnvironmentProvider[] | undefined,
  environmentProviderId: string | null,
): ProviderLookup {
  if (environmentProviderId !== null && providers === undefined) {
    return { status: "loading" };
  }
  return {
    status: "loaded",
    environmentProviderId,
    provider:
      providers?.find((candidate) => candidate.id === environmentProviderId) ??
      null,
  };
}

function providerDisplayName(lookup: ProviderLookup): string | null {
  if (lookup.status === "loading") return null;
  if (lookup.provider !== null) return lookup.provider.displayName;
  return lookup.environmentProviderId === null
    ? null
    : `${lookup.environmentProviderId} (not installed)`;
}

function workspaceLabel(
  { display: { lifecycle }, providerLookup }: LabelArgs,
  locality: "local" | "remote",
): string {
  if (lifecycle === "provisioning") return "Provisioning";
  if (lifecycle === "removed") return "Unavailable — machine removed";
  if (lifecycle === "destroyed") return "Environment unavailable";
  if (lifecycle !== null) return machineRemovalLabels[lifecycle];
  return (
    providerDisplayName(providerLookup) ??
    (locality === "remote" ? "Remote" : "Local")
  );
}

export function getEnvironmentLabelIconName(lookup: ProviderLookup): IconName {
  return lookup.status === "loaded" && lookup.provider !== null
    ? pluginIconName(lookup.provider.icon)
    : "Laptop";
}

export function getEnvironmentWorkspaceInfoDisplay(
  args: LabelArgs & { hostName: string | null; locality: "local" | "remote" },
): { label: string; icon: IconName; machineName: string | null } {
  return {
    label: workspaceLabel(args, args.locality),
    icon: getEnvironmentLabelIconName(args.providerLookup),
    machineName: args.hostName,
  };
}

function summaryLabel(
  args: LabelArgs,
  hasMultipleMachines: boolean,
  host: SummaryHost | null,
): string | null {
  const { lifecycle } = args.display;
  if (lifecycle !== null) return workspaceLabel(args, "remote");
  if (args.providerLookup.status === "loading") return null;
  return host !== null && isHostAmbiguous(hasMultipleMachines, host.type)
    ? host.name
    : providerDisplayName(args.providerLookup);
}

export function getEnvironmentSummaryChrome(
  args: LabelArgs & { hasMultipleMachines: boolean; host: SummaryHost | null },
): {
  environmentLabel: string | undefined;
  environmentCompactLabel: string | undefined;
  environmentIcon: IconName | undefined;
  environmentProviderName: string | undefined;
  environmentHost: SummaryHost | undefined;
} {
  const { host } = args;
  const label = summaryLabel(args, args.hasMultipleMachines, host) ?? undefined;
  const isProvisioning = args.display.lifecycle === "provisioning";
  const providerName = isProvisioning
    ? null
    : providerDisplayName(args.providerLookup);
  return {
    environmentLabel: label,
    environmentCompactLabel: label,
    environmentIcon:
      label === undefined
        ? undefined
        : isProvisioning
          ? "Loading"
          : getEnvironmentLabelIconName(args.providerLookup),
    environmentProviderName:
      label === undefined ? undefined : (providerName ?? undefined),
    environmentHost: host !== null && label === host.name ? host : undefined,
  };
}
