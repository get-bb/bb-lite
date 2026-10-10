import { cliCommand, defineCli, type PluginServerApi } from "@bb/plugin";
import { policySchema, storageRetention } from "./contract.js";

const MACHINE = { type: "string", description: "Machine ID" } as const;
const YES = {
  type: "boolean",
  description: "Confirm this destructive operation",
} as const;

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`Provide --${name}.`);
  return value;
}

function flag(value: string | undefined, fallback: boolean, name: string) {
  if (value === undefined) return fallback;
  if (value !== "true" && value !== "false")
    throw new Error(`Use true or false for --${name}.`);
  return value === "true";
}

function days(value: string | undefined, fallback: number | null) {
  if (value === undefined) return fallback;
  if (value === "never") return null;
  if (!/^\d+$/.test(value))
    throw new Error("Use a number of days (1–3650) or never.");
  return Number(value);
}

function confirm(yes: boolean, message: string) {
  if (!yes) throw new Error(message);
}

async function output(work: () => Promise<unknown>) {
  try {
    const stdout = JSON.stringify(await work(), null, 2) + "\n";
    return { exitCode: 0, stdout };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stderr: message + "\n" };
  }
}

export function registerCli(bb: PluginServerApi) {
  const ops = storageRetention;
  bb.cli.register(
    defineCli({
      name: "storage",
      summary: "Inspect storage and manage thread retention (JSON output)",
      commands: {
        retention: cliCommand({
          summary:
            "Show policy and last run, preview thresholds, or save with --save --yes",
          options: {
            "archive-after": {
              type: "string",
              description: "Idle days before archiving, or never",
            },
            "delete-after": {
              type: "string",
              description: "Archived days before deleting, or never",
            },
            "delete-storage-on-archive": {
              type: "string",
              description: "Delete thread storage on archive: true or false",
            },
            "delete-dev-data-on-checkout-removal": {
              type: "string",
              description:
                "Delete development data for missing checkouts: true or false",
            },
            save: {
              type: "boolean",
              description: "Save the supplied settings",
            },
            yes: YES,
          },
          run: ({ options }) =>
            output(async () => {
              const state = await bb.call(ops.state, {});
              const storage = options["delete-storage-on-archive"];
              const dev = options["delete-dev-data-on-checkout-removal"];
              const policy = policySchema.parse({
                archiveAfterDays: days(
                  options["archive-after"],
                  state.policy.archiveAfterDays,
                ),
                deleteAfterDays: days(
                  options["delete-after"],
                  state.policy.deleteAfterDays,
                ),
                deleteStorageOnArchive: flag(
                  storage,
                  state.policy.deleteStorageOnArchive,
                  "delete-storage-on-archive",
                ),
                deleteDevDataOnCheckoutRemoval: flag(
                  dev,
                  state.policy.deleteDevDataOnCheckoutRemoval,
                  "delete-dev-data-on-checkout-removal",
                ),
              });
              if (options.save) {
                confirm(
                  options.yes,
                  "Preview first, then pass --save --yes to confirm the policy.",
                );
                return bb.call(ops.configure, policy);
              }
              const changed = [
                options["archive-after"],
                options["delete-after"],
                storage,
                dev,
              ].some((value) => value !== undefined);
              if (!changed) return state;
              return { policy, preview: await bb.call(ops.preview, policy) };
            }),
        }),
        usage: cliCommand({
          summary:
            "Read cached machine usage; --rescan scans --machine, or every online machine",
          options: {
            machine: MACHINE,
            rescan: {
              type: "boolean",
              description: "Scan --machine, or every online machine",
            },
          },
          run: ({ options }) =>
            output(() => {
              const input =
                options.machine === undefined
                  ? {}
                  : { hostId: options.machine };
              return bb.call(options.rescan ? ops.scan : ops.usage, input);
            }),
        }),
        "remove-orphans": cliCommand({
          summary: "Remove orphaned storage from the last scan",
          options: { machine: MACHINE, yes: YES },
          run: ({ options }) =>
            output(async () => {
              confirm(
                options.yes,
                "Pass --yes to permanently remove orphaned storage.",
              );
              const hostId = required(options.machine, "machine");
              return bb.call(ops.removeOrphans, { hostId });
            }),
        }),
        "retry-worktree-cleanup": cliCommand({
          summary: "Retry cleanup of leftover worktrees",
          options: { machine: MACHINE },
          run: ({ options }) =>
            output(async () => {
              const hostId = required(options.machine, "machine");
              return bb.call(ops.retryWorktreeCleanup, { hostId });
            }),
        }),
        "clear-thread": cliCommand({
          summary: "Empty a stopped thread's storage directory",
          options: {
            thread: { type: "string", description: "Thread ID" },
            yes: YES,
          },
          run: ({ options }) =>
            output(async () => {
              confirm(
                options.yes,
                "Pass --yes to permanently clear thread storage.",
              );
              const threadId = required(options.thread, "thread");
              return bb.call(ops.clearThread, { threadId });
            }),
        }),
        "clear-archived-files": cliCommand({
          summary:
            "Clear all stored files from archived, stopped, unpinned threads on a machine",
          options: { machine: MACHINE, yes: YES },
          run: ({ options }) =>
            output(async () => {
              confirm(
                options.yes,
                "Pass --yes to permanently clear archived thread files.",
              );
              const hostId = required(options.machine, "machine");
              return bb.call(ops.clearArchivedFiles, { hostId });
            }),
        }),
        cleanup: cliCommand({
          summary: "Run cleanup of one kind on a machine and print its result",
          options: {
            machine: MACHINE,
            kind: { type: "string", description: "orphans or worktrees" },
            yes: YES,
          },
          run: ({ options }) =>
            output(async () => {
              confirm(options.yes, "Pass --yes to confirm cleanup.");
              const hostId = required(options.machine, "machine");
              if (options.kind === "orphans")
                return bb.call(ops.removeOrphans, { hostId });
              if (options.kind === "worktrees")
                return bb.call(ops.retryWorktreeCleanup, { hostId });
              throw new Error("Use --kind orphans or worktrees.");
            }),
        }),
        "clear-large-files": cliCommand({
          summary:
            "Delete files of 10 MB or more from archived threads on --machine, or on every scanned online machine",
          options: { machine: MACHINE, yes: YES },
          run: ({ options }) =>
            output(async () => {
              confirm(
                options.yes,
                "Pass --yes to permanently delete large files from archived threads.",
              );
              return bb.call(ops.clearLargeFiles, {
                ...(options.machine ? { hostId: options.machine } : {}),
              });
            }),
        }),
      },
    }),
  );
}
