import {
  cliCommand,
  defineCli,
  machines,
  PluginCliError,
  type PluginServerApi,
} from "@bb/plugin";
import {
  keepAwake,
  keepAwakeSettings,
  MAX_SELECTED_HOSTS,
  type KeepAwakeSettings,
} from "./contract.js";

const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const CONFIGURATION_KEY = "configuration";
const JSON_OPTION = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalize(settings: KeepAwakeSettings): KeepAwakeSettings {
  const { enabled, selection } = settings;
  if (selection.mode === "all") return { enabled, selection };
  const hostIds = [...new Set(selection.hostIds)];
  return { enabled, selection: { mode: "selected", hostIds } };
}

function invalidSelection(message: string, hint?: string): PluginCliError {
  return new PluginCliError(message, { code: "invalid_host_selection", hint });
}

export default async function keepAwakeServer(
  bb: PluginServerApi,
): Promise<void> {
  const stored = keepAwakeSettings.safeParse(
    await bb.storage.kv.get<unknown>(CONFIGURATION_KEY),
  );
  let settings: KeepAwakeSettings = stored.success
    ? normalize(stored.data)
    : { enabled: false, selection: { mode: "all" } };
  let requested = true;
  let wake = () => {};
  const request = () => {
    requested = true;
    wake();
  };

  const configuration = async () => {
    const hosts = await bb.call(machines.list, {});
    const summaries = hosts.map(({ id, name, status }) => ({
      id,
      name,
      status,
    }));
    return { ...settings, hosts: summaries };
  };

  const save = async (next: KeepAwakeSettings) => {
    const normalized = normalize(next);
    await bb.storage.kv.set(CONFIGURATION_KEY, normalized);
    settings = normalized;
    bb.changed(keepAwake.configuration);
    request();
  };

  bb.implement(keepAwake.configuration, configuration);
  bb.implement(keepAwake.updateConfiguration, async (next) => {
    await save(next);
    return configuration();
  });
  bb.on(machines.connected, request);
  bb.on(machines.signaled, ({ hostId, pluginId, name }) => {
    if (pluginId !== bb.pluginId || name !== "exited") return;
    bb.log.warn(`Keep Awake stopped unexpectedly on host ${hostId}; retrying`);
  });

  const applyTo = async (hostId: string, wanted: KeepAwakeSettings) => {
    const { selection } = wanted;
    const enabled =
      wanted.enabled &&
      (selection.mode === "all" || selection.hostIds.includes(hostId));
    try {
      const actual = await bb.runners.call(hostId, keepAwake.updateMachine, {
        enabled,
      });
      if (!actual.supported) {
        if (enabled) {
          bb.log.warn(
            `Keep Awake is enabled but host ${hostId} is not macOS or Windows`,
          );
        }
        return true;
      }
      if (actual.enabled === enabled) return true;
      bb.log.warn(
        `Keep Awake did not reach its configured state on host ${hostId}; retrying`,
      );
    } catch (error) {
      bb.log.warn(
        `Could not reconcile Keep Awake on host ${hostId}: ${messageOf(error)}`,
      );
    }
    return false;
  };

  const reconcile = async () => {
    try {
      const wanted = settings;
      const hosts = await bb.call(machines.list, {});
      const connected = hosts.filter(({ status }) => status === "connected");
      const results = await Promise.all(
        connected.map(({ id }) => applyTo(id, wanted)),
      );
      return results.every(Boolean);
    } catch (error) {
      bb.log.warn(`Could not load Keep Awake state: ${messageOf(error)}`);
      return false;
    }
  };

  bb.background.service("desired-state-reconciler", {
    async start(signal) {
      let retryMs = RETRY_MIN_MS;
      while (!signal.aborted) {
        requested = false;
        const settled = await reconcile();
        if (signal.aborted) break;
        if (requested) continue;
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            wake = () => {};
            resolve();
          };
          const timer = settled ? undefined : setTimeout(done, retryMs);
          wake = done;
          signal.addEventListener("abort", done, { once: true });
        });
        retryMs = settled ? RETRY_MIN_MS : Math.min(retryMs * 2, RETRY_MAX_MS);
      }
    },
  });

  const setEnabled = async (enabled: boolean, json: boolean) => {
    await save({ ...settings, enabled });
    const word = settings.enabled ? "enabled" : "disabled";
    const stdout = json ? JSON.stringify(settings) : `Keep Awake ${word}`;
    return { exitCode: 0, stdout };
  };

  const describeHosts = (separator: string) =>
    settings.selection.mode === "all"
      ? "all"
      : settings.selection.hostIds.join(separator);

  bb.cli.register(
    defineCli({
      name: "keep-awake",
      summary: "Configure idle-sleep prevention",
      commands: {
        status: cliCommand({
          summary: "Show whether Keep Awake is enabled and which hosts it uses",
          options: { json: JSON_OPTION },
          run: ({ options }) => ({
            exitCode: 0,
            stdout: options.json
              ? JSON.stringify(settings)
              : `${settings.enabled ? "Enabled" : "Disabled"}\nHosts: ${describeHosts(", ")}`,
          }),
        }),
        enable: cliCommand({
          summary: "Enable Keep Awake",
          options: { json: JSON_OPTION },
          run: ({ options }) => setEnabled(true, options.json),
        }),
        disable: cliCommand({
          summary: "Disable Keep Awake",
          options: { json: JSON_OPTION },
          run: ({ options }) => setEnabled(false, options.json),
        }),
        hosts: cliCommand({
          summary: "Show or replace the Keep Awake host selection",
          positionals: [
            {
              name: "host-id",
              description: `Host ids to keep awake, at most ${MAX_SELECTED_HOSTS}, or the single word "all"; omit every id to print the current selection`,
              variadic: true,
            },
          ],
          options: { json: JSON_OPTION },
          async run({ options, positionals }) {
            const requestedIds = positionals["host-id"];
            if (requestedIds[0] === "all") {
              if (requestedIds.length !== 1) {
                throw invalidSelection(
                  '"all" cannot be combined with individual host ids',
                  "Run `bb keep-awake hosts all`, or list only host ids.",
                );
              }
              await save({ ...settings, selection: { mode: "all" } });
            } else if (requestedIds.length > 0) {
              if (requestedIds.length > MAX_SELECTED_HOSTS) {
                throw invalidSelection(
                  `Select at most ${MAX_SELECTED_HOSTS} hosts, or use "all"`,
                );
              }
              if (requestedIds.some((hostId) => hostId.length === 0)) {
                throw invalidSelection("Host ids cannot be empty");
              }
              const selection = {
                mode: "selected" as const,
                hostIds: requestedIds,
              };
              await save({ ...settings, selection });
            }
            const all = settings.selection.mode === "all";
            return {
              exitCode: 0,
              stdout: options.json
                ? JSON.stringify(settings.selection)
                : all
                  ? "All hosts"
                  : describeHosts("\n"),
            };
          },
        }),
      },
    }),
  );
}
