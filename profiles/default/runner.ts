import type { RunnerPart } from "@bb/runner";
import { runnerEntries } from "./builtins.runner.js";
import { LOADED_FIRST } from "./profiles.js";

const ids = Object.keys(runnerEntries);
const ordered = [
  ...LOADED_FIRST.filter((id) => ids.includes(id)),
  ...ids.filter((id) => !LOADED_FIRST.includes(id)).sort(),
];

export const runnerParts: RunnerPart[] = ordered.flatMap((id) => {
  const entry = runnerEntries[id];
  return entry === undefined ? [] : [{ id, entry }];
});
