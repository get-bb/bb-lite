import type { PluginRunnerEntry } from "@bb/runner";
import automations from "../../plugins/automations/runner.js";
import browserAutomation from "../../plugins/browser-automation/runner.js";
import concurrencyLimit from "../../plugins/concurrency-limit/runner.js";
import connect from "../../plugins/connect/src/runner.js";
import github from "../../plugins/github/runner.js";
import keepAwake from "../../plugins/keep-awake/runner.js";
import providerClaudeCode from "../../plugins/provider-claude-code/runner.js";
import providerCodex from "../../plugins/provider-codex/runner.js";
import providerEcho from "../../plugins/provider-echo/runner.js";
import providerPi from "../../plugins/provider-pi/runner.js";
import skills from "../../plugins/skills/runner.js";
import storageRetention from "../../plugins/storage-retention/runner.js";

export const runnerEntries: Record<string, PluginRunnerEntry> = {
  automations: automations,
  "browser-automation": browserAutomation,
  "concurrency-limit": concurrencyLimit,
  connect: connect,
  github: github,
  "keep-awake": keepAwake,
  "provider-claude-code": providerClaudeCode,
  "provider-codex": providerCodex,
  "provider-echo": providerEcho,
  "provider-pi": providerPi,
  skills: skills,
  "storage-retention": storageRetention,
};
