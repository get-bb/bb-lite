export interface Profile {
  description: string;
  plugins: readonly string[];
}

const PROVIDERS = ["provider-codex", "provider-claude-code", "provider-echo"];
const ENVIRONMENT_KINDS = [
  "environment-project-checkout",
  "environment-git-worktree",
  "environment-personal-workspace",
];
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
  "bb-account",
  "connect",
  "account-pool",
  "tasks",
  "concurrency-limit",
  "keep-awake",
  "provider-pi",
  "push-notifications",
  "github",
  "storage-retention",
];

export const profiles: Record<string, Profile> = {
  default: {
    description: "The whole product.",
    plugins: [
      ...PROVIDERS,
      ...ENVIRONMENT_KINDS,
      ...SCREEN,
      ...AGENT_FEATURES,
      ...PRODUCT,
    ],
  },
  headless: {
    description:
      "No screen plugins: a server that only the CLI and agents talk to.",
    plugins: [
      ...PROVIDERS,
      ...ENVIRONMENT_KINDS,
      ...AGENT_FEATURES,
      ...PRODUCT,
    ],
  },
  minimal: {
    description: "Providers and the plugin tools, nothing else.",
    plugins: [...PROVIDERS, ...ENVIRONMENT_KINDS, "plugin-dev"],
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

export const LOADED_FIRST = [
  ...PROVIDERS,
  ...ENVIRONMENT_KINDS,
  "thread-list",
  "navigation",
];
