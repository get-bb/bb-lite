import { sessions, type PluginServerApi } from "@bb/plugin";
import { echoEnabled } from "./enabled.js";

export default function plugin(bb: PluginServerApi): void {
  if (!echoEnabled()) return;
  bb.add(sessions.provider, {
    id: "echo",
    displayName: "Echo",
    logo: null,
    completedTurnDisplay: "collapse",
    reasoningLevels: ["low", "medium", "high"],
    composerCommands: [],
    capabilities: {
      supportsThreadArchive: false,
      supportsThreadRename: false,
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      supportsSessionRewind: false,
      fork: "checkpoint",
    },
    optional: {},
  });
}
