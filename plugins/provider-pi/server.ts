import { readFileSync } from "node:fs";
import { sessions, type PluginServerApi } from "@bb/plugin";

export default function plugin(bb: PluginServerApi): void {
  bb.add(sessions.provider, {
    id: "pi",
    displayName: "Pi",
    logo: readFileSync(new URL("./logo.svg", import.meta.url)),
    completedTurnDisplay: "collapse",
    reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"],
    composerCommands: [],
    capabilities: {
      supportsThreadArchive: false,
      supportsThreadRename: false,
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      supportsSessionRewind: false,
      fork: "checkpoint",
    },
    nativeSkillRoots: {
      user: [".pi/agent/skills", ".agents/skills"],
      project: [".pi/skills", ".agents/skills"],
    },
    permissionModes: ["full"],
    optional: {
      strings: {
        signInHint: "Run `pi` on the machine to sign in.",
        expiredHint: "Your Pi session expired. Run `pi`, then reload.",
        installUrl: "https://pi.dev",
      },
    },
  });
}
