import type { PluginSettingsResponse } from "@bb/server-contract";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { readSetting, writeSetting, type Setting } from "../db/settings.js";
import { invalidRequest } from "../http/errors.js";

interface ProviderToggle {
  label: string;
  description: string;
  default: boolean;
  option: string;
  inverted?: true;
}

type ToggleValues = Record<string, boolean>;

const DISABLE_SUBAGENTS: Omit<ProviderToggle, "description"> = {
  label: "Disable provider subagents",
  default: false,
  option: "providerSubagentsEnabled",
  inverted: true,
};

const PROVIDER_TOGGLES: Record<string, Record<string, ProviderToggle>> = {
  codex: {
    memoryEnabled: {
      label: "Codex memory",
      description:
        "Allow Codex to recall existing memories and generate new memories " +
        "from bb threads.",
      default: true,
      option: "memoryEnabled",
    },
    subagentsDisabled: {
      ...DISABLE_SUBAGENTS,
      description:
        "Prevent Codex from starting native subagents so agents use bb for " +
        "delegation.",
    },
  },
  "claude-code": {
    memoryEnabled: {
      label: "Claude Code memory",
      description:
        "Allow Claude Code to read and write its native auto-memory for bb " +
        "threads.",
      default: true,
      option: "memoryEnabled",
    },
    subagentsDisabled: {
      ...DISABLE_SUBAGENTS,
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
  },
};

function togglesSetting(providerId: string): Setting<ToggleValues> {
  const schema = z.record(z.string(), z.boolean());
  return { key: `providerSettings:${providerId}`, schema, fallback: {} };
}

function readToggleValues(db: Db, providerId: string): ToggleValues {
  const stored = readSetting(db, togglesSetting(providerId));
  const toggles = Object.entries(PROVIDER_TOGGLES[providerId] ?? {});
  return Object.fromEntries(
    toggles.map(([key, toggle]) => [key, stored[key] ?? toggle.default]),
  );
}

export const PROVIDERS_WITH_SETTINGS = Object.keys(PROVIDER_TOGGLES);

export function providerOptionsFor(
  db: Db,
  providerId: string,
): Record<string, unknown> {
  const values = readToggleValues(db, providerId);
  const toggles = Object.entries(PROVIDER_TOGGLES[providerId] ?? {});
  return Object.fromEntries(
    toggles.map(([key, { option, inverted }]) => {
      const enabled = values[key] === true;
      return [option, inverted === true ? !enabled : enabled];
    }),
  );
}

export function providerSettingsView(
  db: Db,
  providerId: string,
): PluginSettingsResponse {
  const toggles = Object.entries(PROVIDER_TOGGLES[providerId] ?? {});
  const schema = Object.fromEntries(
    toggles.map(([key, { label, description, default: fallback }]) => {
      const type = "boolean" as const;
      return [key, { type, label, description, default: fallback }];
    }),
  );
  return { ok: true, schema, values: readToggleValues(db, providerId) };
}

export function updateProviderSettings(
  db: Db,
  providerId: string,
  values: Record<string, unknown>,
): void {
  const next = readToggleValues(db, providerId);
  for (const [key, value] of Object.entries(values)) {
    if (!(key in next)) throw invalidRequest(`Unknown setting '${key}'`);
    if (typeof value !== "boolean") {
      throw invalidRequest(`Setting '${key}' must be true or false`);
    }
    next[key] = value;
  }
  writeSetting(db, togglesSetting(providerId), next);
}
