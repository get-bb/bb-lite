import { readFileSync } from "node:fs";
import {
  sessions,
  type PluginServerApi,
  type ProviderToggle,
} from "@bb/plugin";
import { codexTitle } from "./title-service.js";

const settings: Record<string, ProviderToggle> = {
  memoryEnabled: {
    label: "Codex memory",
    description:
      "Allow Codex to recall existing memories and generate new memories " +
      "from bb threads.",
    default: true,
    option: "memoryEnabled",
  },
  subagentsDisabled: {
    label: "Disable provider subagents",
    default: false,
    option: "providerSubagentsEnabled",
    inverted: true,
    description:
      "Prevent Codex from starting native subagents so agents use bb for " +
      "delegation.",
  },
};

export default function plugin(bb: PluginServerApi): void {
  bb.settings.define(
    Object.fromEntries(
      Object.entries(settings).map(([key, toggle]) => {
        const { label, description, default: fallback } = toggle;
        const type = "boolean" as const;
        return [key, { type, label, description, default: fallback }];
      }),
    ),
  );
  bb.add(sessions.titleFallback, (task, signal) => codexTitle(task, signal));
  bb.add(sessions.provider, {
    id: "codex",
    displayName: "Codex",
    logo: readFileSync(new URL("./logo.svg", import.meta.url)),
    completedTurnDisplay: "collapse",
    reasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
    composerCommands: ["goal"],
    capabilities: {
      supportsThreadArchive: true,
      supportsThreadRename: true,
      supportsServiceTier: true,
      supportsNativeUserQuestion: false,
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
    settings,
  });
}
