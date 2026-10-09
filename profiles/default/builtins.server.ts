import type { PluginServerEntry } from "@bb/plugin";
import accountPool from "../../plugins/account-pool/src/server.js";
import askUserQuestion from "../../plugins/ask-user-question/src/server.js";
import audit from "../../plugins/audit/server.js";
import auditLog from "../../plugins/audit-log/server.js";
import bbGuide from "../../plugins/bb-guide/server.js";
import concurrencyLimit from "../../plugins/concurrency-limit/server.js";
import connect from "../../plugins/connect/src/server.js";
import customInstructions from "../../plugins/custom-instructions/server.js";
import drafts from "../../plugins/drafts/server.js";
import environmentGitWorktree from "../../plugins/environment-git-worktree/server.js";
import environmentPersonalWorkspace from "../../plugins/environment-personal-workspace/server.js";
import environmentProjectCheckout from "../../plugins/environment-project-checkout/server.js";
import environments from "../../plugins/environments/server.js";
import identity from "../../plugins/identity/server.js";
import inlineVis from "../../plugins/inline-vis/server.js";
import keepAwake from "../../plugins/keep-awake/server.js";
import machines from "../../plugins/machines/server.js";
import memory from "../../plugins/memory/server.js";
import pluginApiTester from "../../plugins/plugin-api-tester/server.js";
import pluginDev from "../../plugins/plugin-dev/server.js";
import projects from "../../plugins/projects/server.js";
import promptLibrary from "../../plugins/prompt-library/server.js";
import providerClaudeCode from "../../plugins/provider-claude-code/server.js";
import providerCodex from "../../plugins/provider-codex/server.js";
import providerEcho from "../../plugins/provider-echo/server.js";
import providerPi from "../../plugins/provider-pi/server.js";
import providerRetry from "../../plugins/provider-retry/server.js";
import providerUsage from "../../plugins/provider-usage/server.js";
import pushNotifications from "../../plugins/push-notifications/server.js";
import secrets from "../../plugins/secrets/src/server.js";
import sessions from "../../plugins/sessions/server.js";
import settings from "../../plugins/settings/server.js";
import tasks from "../../plugins/tasks/server.js";
import terminals from "../../plugins/terminals/server.js";
import threadList from "../../plugins/thread-list/server.js";
import threads from "../../plugins/threads/server.js";
import workspace from "../../plugins/workspace/server.js";

export const serverEntries: Record<string, PluginServerEntry | null> = {
  "account-pool": accountPool,
  "ask-user-question": askUserQuestion,
  audit: audit,
  "audit-log": auditLog,
  "bb-guide": bbGuide,
  composer: null,
  "concurrency-limit": concurrencyLimit,
  connect: connect,
  "custom-instructions": customInstructions,
  drafts: drafts,
  "environment-git-worktree": environmentGitWorktree,
  "environment-personal-workspace": environmentPersonalWorkspace,
  "environment-project-checkout": environmentProjectCheckout,
  environments: environments,
  identity: identity,
  "inline-vis": inlineVis,
  "keep-awake": keepAwake,
  machines: machines,
  memory: memory,
  navigation: null,
  "pdf-preview": null,
  "plugin-api-tester": pluginApiTester,
  "plugin-dev": pluginDev,
  projects: projects,
  "prompt-library": promptLibrary,
  "provider-claude-code": providerClaudeCode,
  "provider-codex": providerCodex,
  "provider-echo": providerEcho,
  "provider-pi": providerPi,
  "provider-retry": providerRetry,
  "provider-usage": providerUsage,
  "push-notifications": pushNotifications,
  "scheduled-send": null,
  secrets: secrets,
  sessions: sessions,
  settings: settings,
  shell: null,
  "side-panel": null,
  tasks: tasks,
  terminals: terminals,
  "thread-list": threadList,
  "thread-view": null,
  threads: threads,
  workspace: workspace,
};
