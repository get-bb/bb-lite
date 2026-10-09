import type { PluginRunnerEntry } from "@bb/runner";
import concurrencyLimit from "../../plugins/concurrency-limit/runner.js";
import github from "../../plugins/github/runner.js";
import keepAwake from "../../plugins/keep-awake/runner.js";
import providerClaudeCode from "../../plugins/provider-claude-code/runner.js";
import providerCodex from "../../plugins/provider-codex/runner.js";
import providerEcho from "../../plugins/provider-echo/runner.js";
import providerPi from "../../plugins/provider-pi/runner.js";

export const runnerEntries: Record<string, PluginRunnerEntry> = {
  "concurrency-limit": concurrencyLimit,
  github: github,
  "keep-awake": keepAwake,
  "provider-claude-code": providerClaudeCode,
  "provider-codex": providerCodex,
  "provider-echo": providerEcho,
  "provider-pi": providerPi,
};
