import { readFileSync } from "node:fs";
import {
  sessions,
  type PluginServerApi,
  type ProviderToggle,
} from "@bb/plugin";
import { claudeCode } from "./contract.js";

const FAST_TIER =
  "Faster responses on supported Opus models at a higher cost per token.";

const settings: Record<string, ProviderToggle> = {
  memoryEnabled: {
    label: "Claude Code memory",
    description:
      "Allow Claude Code to read and write its native auto-memory for bb " +
      "threads.",
    default: true,
    option: "memoryEnabled",
  },
  subagentsDisabled: {
    label: "Disable provider subagents",
    default: false,
    option: "providerSubagentsEnabled",
    inverted: true,
    description:
      "Hide Claude Code's native Task tool so agents use bb for delegation.",
  },
  workflowsDisabled: {
    label: "Disable Workflow tool",
    description: "Hide Claude Code's native Workflow tool for bb threads.",
    default: false,
    option: "workflowsEnabled",
    inverted: true,
  },
  disable1MContext: {
    label: "Disable 1M context",
    description:
      "Disable the 1M-token context window for Claude Code threads. " +
      "Applies on the next turn.",
    default: false,
    option: "disable1MContext",
  },
  chromeEnabled: {
    label: "Claude in Chrome",
    description:
      "Start Claude Code with the Claude in Chrome browser tools. Needs " +
      "the Chrome extension and a claude.ai login on the host.",
    default: false,
    option: "chromeEnabled",
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
  bb.add(sessions.usage, {
    providerId: "claude-code",
    scope: "host",
    read: ({ hostId }) =>
      bb.runners.call(hostId ?? bb.runners.localHostId, claudeCode.usage, {}),
  });
  bb.add(sessions.provider, {
    id: "claude-code",
    displayName: "Claude Code",
    logo: readFileSync(new URL("./logo.svg", import.meta.url)),
    completedTurnDisplay: "flat",
    reasoningLevels: ["low", "medium", "high", "xhigh", "ultracode", "max"],
    composerCommands: [],
    capabilities: {
      supportsThreadArchive: false,
      supportsThreadRename: false,
      supportsServiceTier: true,
      supportsNativeUserQuestion: true,
      supportsSessionRewind: true,
      fork: "checkpoint",
    },
    optional: {
      strings: {
        signInHint: "Run `claude` on the machine to sign in.",
        expiredHint: "Your Claude session expired. Run `claude`, then reload.",
        installUrl: "https://claude.com/claude-code",
        brandPrefix: "Claude ",
        iconTint: { light: "#D97757", dark: "#D97757" },
      },
      serviceTiers: [
        { id: "default", label: "Default" },
        { id: "fast", label: "Fast", description: FAST_TIER },
      ],
    },
    settings,
  });
}
