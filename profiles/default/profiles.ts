export interface Profile {
  description: string;
  plugins: readonly string[];
}

const PROVIDERS = ["provider-codex", "provider-claude-code", "provider-echo"];
const SCREEN = [
  "thread-list",
  "navigation",
  "pdf-preview",
  "inline-vis",
  "scheduled-send",
  "prompt-library",
  "provider-usage",
];
const AGENT_FEATURES = [
  "secrets",
  "ask-user-question",
  "custom-instructions",
  "bb-guide",
  "drafts",
  "provider-retry",
  "memory",
  "audit",
  "plugin-dev",
  "plugin-api-tester",
];
const PRODUCT = [
  "connect",
  "account-pool",
  "tasks",
  "concurrency-limit",
  "keep-awake",
];

export const profiles: Record<string, Profile> = {
  default: {
    description: "The whole product.",
    plugins: [...PROVIDERS, ...SCREEN, ...AGENT_FEATURES, ...PRODUCT],
  },
  headless: {
    description:
      "No screen plugins: a server that only the CLI and agents talk to.",
    plugins: [...PROVIDERS, ...AGENT_FEATURES, ...PRODUCT],
  },
  minimal: {
    description: "Providers and the plugin tools, nothing else.",
    plugins: [...PROVIDERS, "plugin-dev"],
  },
};

export const CORE = [
  "identity",
  "settings",
  "projects",
  "machines",
  "sessions",
  "threads",
  "environments",
  "terminals",
  "workspace",
  "audit-log",
  "shell",
  "thread-view",
  "composer",
  "side-panel",
];

export const LOADED_FIRST = [...PROVIDERS, "thread-list", "navigation"];
