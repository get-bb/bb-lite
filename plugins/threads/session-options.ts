import { fail, threads, type PluginServerApi } from "@bb/plugin";
import {
  THREAD_PROVIDER_COMMANDS_STATE_KIND,
  THREAD_SESSION_OPTIONS_STATE_KIND,
  THREAD_SESSION_OPTION_SELECTIONS_STATE_KIND,
  applySessionOptionSelectionPatch,
  describeSessionOptionConflict,
  modelSessionOptionConflict,
  pendingSessionOptionSelections,
  threadProviderCommandsStateSchema,
  threadScope,
  threadSessionOptionSelectionsStateSchema,
  threadSessionOptionsStateSchema,
  type SessionOptionSelectionPatch,
  type SessionOptionSelections,
  type ThreadSessionOption,
} from "@bb/domain";
import type { Db } from "@bb/server-kit/db/index";
import type { ThreadRow } from "@bb/server-kit/db/threads";
import type { Outbox } from "./core.js";
import type { Engine } from "./engine.js";

type StateKind =
  | typeof THREAD_PROVIDER_COMMANDS_STATE_KIND
  | typeof THREAD_SESSION_OPTIONS_STATE_KIND
  | typeof THREAD_SESSION_OPTION_SELECTIONS_STATE_KIND;

interface StateSnapshot {
  payload: unknown;
  providerThreadId: string | null;
}

interface SessionOptionState {
  options: ThreadSessionOption[];
  optionsReported: boolean;
  providerThreadId: string | null;
  selections: SessionOptionSelections;
}

function latestState(
  db: Db,
  threadId: string,
  kind: StateKind,
): StateSnapshot | null {
  const row = db.get<{ payload: string | null; providerThreadId: string }>(
    `SELECT json_extract(data, '$.payload') AS payload,
       provider_thread_id AS providerThreadId
     FROM events
     WHERE thread_id = ? AND type = 'thread/extensionState/updated'
       AND json_extract(data, '$.kind') = ?
     ORDER BY sequence DESC LIMIT 1`,
    threadId,
    kind,
  );
  if (row === undefined) return null;
  const payload: unknown =
    row.payload === null ? null : JSON.parse(row.payload);
  return { payload, providerThreadId: row.providerThreadId };
}

function readState(db: Db, threadId: string): SessionOptionState {
  const reported = latestState(db, threadId, THREAD_SESSION_OPTIONS_STATE_KIND);
  const options = threadSessionOptionsStateSchema.safeParse(reported?.payload);
  const selections = threadSessionOptionSelectionsStateSchema.safeParse(
    latestState(db, threadId, THREAD_SESSION_OPTION_SELECTIONS_STATE_KIND)
      ?.payload,
  );
  return {
    options: options.success ? options.data.options : [],
    optionsReported: reported !== null,
    providerThreadId: reported?.providerThreadId ?? null,
    selections: selections.success ? selections.data.selections : {},
  };
}

function sameSelections(
  left: SessionOptionSelections,
  right: SessionOptionSelections,
): boolean {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && left[key] === right[key])
  );
}

function writeSelections(
  engine: Engine,
  out: Outbox,
  thread: ThreadRow,
  providerThreadId: string,
  selections: SessionOptionSelections,
): void {
  engine.append(out, thread, [
    {
      type: "thread/extensionState/updated",
      scope: threadScope(),
      providerThreadId,
      kind: THREAD_SESSION_OPTION_SELECTIONS_STATE_KIND,
      payload: { selections },
    },
  ]);
  out.after(() => engine.bb.changed(threads.sessionOptions));
}

export function providerCommands(db: Db, threadId: string) {
  const state = threadProviderCommandsStateSchema.safeParse(
    latestState(db, threadId, THREAD_PROVIDER_COMMANDS_STATE_KIND)?.payload,
  );
  return { commands: state.success ? state.data.commands : [] };
}

export function sessionOptions(db: Db, threadId: string) {
  const state = readState(db, threadId);
  const selections = state.optionsReported
    ? pendingSessionOptionSelections(state.options, state.selections)
    : state.selections;
  const options = state.options.map((option): ThreadSessionOption => {
    if (!Object.hasOwn(selections, option.id)) return option;
    const value = selections[option.id];
    if (option.type === "boolean") {
      return typeof value === "boolean" ? { ...option, value } : option;
    }
    return typeof value === "string" ? { ...option, value } : option;
  });
  return { options, selections };
}

export function pendingSelections(
  db: Db,
  threadId: string,
): SessionOptionSelections {
  return sessionOptions(db, threadId).selections;
}

export function seedSelections(
  engine: Engine,
  out: Outbox,
  thread: ThreadRow,
  selections: SessionOptionSelections,
): void {
  if (Object.keys(selections).length === 0) return;
  writeSelections(engine, out, thread, "", selections);
}

export function updateSelections(
  engine: Engine,
  thread: ThreadRow,
  patch: SessionOptionSelectionPatch,
): void {
  const state = readState(engine.bb.db, thread.id);
  const result = applySessionOptionSelectionPatch({
    options: state.options,
    selections: state.selections,
    patch,
  });
  if (!result.ok) throw fail("invalid", result.message);
  if (
    state.providerThreadId === null ||
    sameSelections(state.selections, result.selections)
  ) {
    return;
  }
  const { providerThreadId } = state;
  engine.commit((out) =>
    writeSelections(engine, out, thread, providerThreadId, result.selections),
  );
}

export function onProviderState(
  engine: Engine,
  out: Outbox,
  thread: ThreadRow,
  kind: string,
): void {
  if (kind === THREAD_PROVIDER_COMMANDS_STATE_KIND) {
    out.after(() => engine.bb.changed(threads.providerCommands));
    return;
  }
  if (kind !== THREAD_SESSION_OPTIONS_STATE_KIND) return;
  out.after(() => engine.bb.changed(threads.sessionOptions));
  const state = readState(engine.bb.db, thread.id);
  if (state.providerThreadId === null) return;
  const pending = pendingSessionOptionSelections(
    state.options,
    state.selections,
  );
  if (sameSelections(state.selections, pending)) return;
  writeSelections(engine, out, thread, state.providerThreadId, pending);
}

interface FitArgs {
  hostId: string;
  providerId: string;
  model: string;
  named: boolean;
  selections: SessionOptionSelections;
}

export async function modelFittingOptions(
  bb: PluginServerApi,
  args: FitArgs,
): Promise<string | null> {
  if (Object.keys(args.selections).length === 0) return null;
  const runner = bb.runners.get(args.hostId);
  const catalog = await runner
    .listModels({ providerId: args.providerId, cwd: null })
    .catch(() => null);
  if (catalog === null) return null;
  const chosen = catalog.models.find(({ model }) => model === args.model);
  const conflict =
    chosen === undefined
      ? null
      : modelSessionOptionConflict(chosen, args.selections);
  const compatible = catalog.models.filter(
    (candidate) =>
      modelSessionOptionConflict(candidate, args.selections) === null,
  );
  const replacement =
    compatible.find((candidate) => candidate.isDefault) ?? compatible.at(0);
  if (chosen === undefined || conflict === null || replacement === undefined) {
    return null;
  }
  if (args.named) {
    const name = (model: { displayName: string; model: string }) =>
      model.displayName || model.model;
    throw fail(
      "invalid",
      `${name(chosen)} cannot run with the chosen options: ` +
        `${describeSessionOptionConflict(conflict)}. ${name(replacement)} can.`,
    );
  }
  return replacement.model;
}
