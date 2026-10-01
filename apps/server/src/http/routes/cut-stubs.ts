import { defaultAiServiceSelections } from "@bb/domain";
import {
  publicApiRoutes,
  type SystemAppUpdateStatus,
  type SystemMachineProvider,
  type SystemVersionResponse,
} from "@bb/server-contract";
import type { ServerContext } from "../../context.js";
import { typedApi, type ApiApp } from "../api.js";

const MANUAL_MACHINE_PROVIDER: SystemMachineProvider = {
  id: "manual",
  displayName: "Manual machine setup",
  description:
    "Run one command on a machine you already have to connect it to this " +
    "server.",
  icon: "Terminal",
  logoUrl: null,
  pluginId: "core",
  inputs: null,
  acceptsEmptyInputs: true,
  supportsSuspend: false,
};

function versionWithoutUpdates(currentVersion: string): SystemVersionResponse {
  const none = { latestVersion: null, updateAvailable: false };
  const fixed = { source: "npm" as const, isDevelopment: false };
  return { currentVersion, ...none, ...fixed, upgradeCommand: "" };
}

function appUpdateUnsupported(version: string): SystemAppUpdateStatus {
  return {
    activity: { phase: "idle" },
    available: null,
    blocked: null,
    current: { commit: null, version },
    lastResult: null,
    runningThreadCount: 0,
    support: { kind: "unsupported", reason: "unmanaged" },
  };
}

export function registerCutFeatureStubs(app: ApiApp, ctx: ServerContext): void {
  const { get } = typedApi(app);
  const { system, environments } = publicApiRoutes;
  const { version } = ctx.config;
  const noAiServices = { selections: defaultAiServiceSelections, services: [] };

  get(system.aiServices, (c) => c.json(noAiServices));
  get(system.machineProviders, (c) =>
    c.json({ providers: [MANUAL_MACHINE_PROVIDER] }),
  );
  get(system.mobileAppReleases, (c) => c.json({ android: null }));
  get(system.version, (c) => c.json(versionWithoutUpdates(version)));
  get(system.appUpdate, (c) => c.json(appUpdateUnsupported(version)));
  get(environments.pullRequest, (c) => c.json({ outcome: "absent" }));
}
