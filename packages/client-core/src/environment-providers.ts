interface EnvironmentKind {
  id: string;
  workspace?: string;
  default?: number;
  requires: { projectless: boolean };
}

export type EnvironmentKindWanted =
  | { projectless: boolean }
  | { workspace: string };

export function defaultEnvironmentProvider<Kind extends EnvironmentKind>(
  providers: readonly Kind[],
  want: EnvironmentKindWanted,
): Kind | undefined {
  const fits = (kind: Kind) =>
    "workspace" in want
      ? (kind.workspace ?? "unmanaged") === want.workspace
      : kind.requires.projectless === want.projectless;
  return providers
    .filter((kind) => kind.default !== undefined && fits(kind))
    .sort((a, b) => (b.default ?? 0) - (a.default ?? 0))[0];
}
