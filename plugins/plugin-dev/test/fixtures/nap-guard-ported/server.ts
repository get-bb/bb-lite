import {
  cliCommand,
  defineCli,
  machines,
  PluginCliError,
  type PluginServerApi,
} from "@bb/plugin";
import { configuration, napGuard } from "./contract.js";

export default function napGuardServer(bb: PluginServerApi): void {
  const settings = bb.settings.define({
    intervalSeconds: {
      type: "number",
      label: "Interval",
      description: "Seconds between checks",
      default: 30,
    },
  });
  const read = async () =>
    configuration.parse(
      (await bb.storage.kv.get<unknown>("configuration")) ?? {
        enabled: false,
      },
    );
  const write = async (next: { enabled: boolean }) => {
    await bb.storage.kv.set("configuration", next);
    bb.changed(napGuard.configuration);
    return next;
  };
  bb.implement(napGuard.configuration, () => read());
  bb.implement(napGuard.updateConfiguration, (input) => write(input));
  bb.cli.register(
    defineCli({
      name: "nap-guard",
      summary: "Keep hosts awake",
      commands: {
        status: cliCommand({
          summary: "Show state",
          run: async () => {
            const hosts = await bb.call(machines.list, {});
            const state = await read();
            return {
              exitCode: 0,
              stdout: `${state.enabled ? "Enabled" : "Disabled"}, ${hosts.length} hosts`,
            };
          },
        }),
        enable: cliCommand({
          summary: "Enable",
          run: async () => {
            await write({ enabled: true });
            return { exitCode: 0, stdout: "Enabled" };
          },
        }),
        disable: cliCommand({
          summary: "Disable",
          run: async () => {
            if (!(await read()).enabled)
              throw new PluginCliError("already off");
            await write({ enabled: false });
            return { exitCode: 0, stdout: "Disabled" };
          },
        }),
      },
    }),
  );
  bb.background.service("reconciler", {
    start: (signal) => {
      bb.on(machines.connected, async () => {
        if (signal.aborted) return;
        const { intervalSeconds } = await settings.get();
        bb.log.info(`host connected, interval ${intervalSeconds}`);
      });
    },
  });
}
