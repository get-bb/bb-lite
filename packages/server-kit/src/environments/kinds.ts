import type { WorkspaceProvisionType } from "@bb/domain";
import {
  environments,
  type EnvironmentDefinition,
  type PluginServerApi,
} from "@bb/plugin";

export interface KindWanted {
  personal?: boolean;
  workspace?: WorkspaceProvisionType;
}

export function kindWorkspace(
  kind: EnvironmentDefinition | null,
): WorkspaceProvisionType {
  return kind?.workspace ?? "unmanaged";
}

function fits(kind: EnvironmentDefinition, want: KindWanted) {
  if (want.workspace !== undefined) {
    return kindWorkspace(kind) === want.workspace;
  }
  return (kind.requires?.projectless ?? false) === (want.personal ?? false);
}

export function defaultKinds(
  bb: PluginServerApi,
  want: KindWanted,
): EnvironmentDefinition[] {
  return bb
    .entries(environments.kind)
    .flatMap(({ item }) =>
      item.default !== undefined && fits(item, want) ? [item] : [],
    )
    .sort((a, b) => (b.default ?? 0) - (a.default ?? 0));
}
