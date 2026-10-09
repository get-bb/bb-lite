export interface Profile {
  description: string;
  plugins: readonly string[];
}

const PROVIDERS = ["provider-codex", "provider-claude-code", "provider-echo"];
const AGENT_FEATURES = [
  "secrets",
  "ask-user-question",
  "custom-instructions",
  "bb-guide",
  "drafts",
  "audit",
  "plugin-dev",
];
const SCREEN = ["thread-list", "navigation"];
const PRODUCT = ["connect", "account-pool", "tasks"];

export const profiles: Record<string, Profile> = {
  default: {
    description: "The whole product.",
    plugins: [...PROVIDERS, ...SCREEN, ...AGENT_FEATURES, ...PRODUCT],
  },
  development: {
    description: "The whole product plus the Plugin API Tester.",
    plugins: [
      ...PROVIDERS,
      ...SCREEN,
      ...AGENT_FEATURES,
      ...PRODUCT,
      "plugin-api-tester",
    ],
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
