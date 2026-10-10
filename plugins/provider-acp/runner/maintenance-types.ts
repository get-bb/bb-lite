export interface ProviderHealth {
  status:
    | "ready"
    | "not_installed"
    | "unauthenticated"
    | "expired"
    | "unsupported_version"
    | "unknown";
  statusMessage: string | null;
  accountEmail: string | null;
  planLabel: string | null;
  installedVersion: string | null;
  minimumSupportedVersion: string | null;
  canInstall: boolean;
  canUpdate: boolean;
  loginCommand: string | null;
}

export interface ProviderUsageWindow {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  cost?: { usedUsdCents: number; limitUsdCents: number };
}

export type ProviderUsage =
  | {
      status: "ok";
      accountKey?: string | null;
      accountEmail: string | null;
      planLabel: string | null;
      windows: ProviderUsageWindow[];
    }
  | { status: "not_installed" }
  | { status: "unauthenticated" }
  | { status: "expired" }
  | {
      status: "error";
      message: string;
      planLabel?: string | null;
      accountEmail?: string | null;
    };

export type ProviderHealthResult =
  | { supported: false }
  | { supported: true; health: ProviderHealth };

export type ProviderUsageResult =
  | { supported: false }
  | { supported: true; usage: ProviderUsage };

export interface ProviderInstallationAction {
  kind: "install" | "update";
  label: "Install" | "Update";
  command: string;
}

export interface ProviderInstallationStatus {
  executableName: string;
  executablePath: string | null;
  installed: boolean;
  installSource: "notInstalled" | "npmGlobal" | "external";
  currentVersion: string | null;
  latestVersion: string | null;
  minimumSupportedVersion: string | null;
  npmPackageName: string | null;
  npmGlobalPackageVersion: string | null;
  installAction: ProviderInstallationAction | null;
  needsUpdate: boolean;
  versionUnsupported: boolean;
}

export type ProviderInstallationRunResult =
  | { available: false; message: string }
  | {
      available: true;
      command: { command: string; args: string[]; displayCommand: string };
      verification: { kind: "installed" };
    };
