import type { RunnerPart } from "@bb/runner";
import claudeCode from "../../plugins/provider-claude-code/runner.js";
import codex from "../../plugins/provider-codex/runner.js";
import echo from "../../plugins/provider-echo/runner.js";

export const runnerParts: RunnerPart[] = [
  { id: "provider-codex", entry: codex },
  { id: "provider-claude-code", entry: claudeCode },
  { id: "provider-echo", entry: echo },
];
