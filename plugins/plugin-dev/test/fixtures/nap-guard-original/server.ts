import {
  defineRpcContract,
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";

const configSchema = z.object({ enabled: z.boolean() });

export const napGuardRpc = defineRpcContract({
  getConfiguration: { input: z.null(), output: configSchema },
  setConfiguration: { input: configSchema, output: configSchema },
});

export default function register(bb: BbPluginApi) {
  const settings = bb.settings.define({
    schema: z.object({ intervalSeconds: z.number().default(30) }),
  });
  const read = async () =>
    configSchema.parse(
      (await bb.storage.kv.get<unknown>("configuration")) ?? { enabled: false },
    );
  const write = async (next: { enabled: boolean }) => {
    await bb.storage.kv.set("configuration", next);
    bb.realtime.publish("configuration", next);
    return next;
  };
  bb.rpc.register(napGuardRpc, {
    getConfiguration: () => read(),
    setConfiguration: (input) => write(input),
  });
  bb.cli.register(
    defineCli({
      description: "Keep hosts awake",
      commands: {
        status: cliCommand({
          description: "Show state",
          options: { json: { type: "boolean", description: "JSON" } },
          run: async () => {
            const hosts = await bb.sdk.hosts.list();
            return { ...(await read()), hosts: hosts.length };
          },
        }),
        enable: cliCommand({
          description: "Enable",
          run: async () => write({ enabled: true }),
        }),
        disable: cliCommand({
          description: "Disable",
          run: async () => {
            if (!(await read()).enabled)
              throw new PluginCliError("already off");
            return write({ enabled: false });
          },
        }),
      },
    }),
  );
  bb.background.service("reconciler", {
    start: () => {
      const off = bb.sdk.subscribe({ type: "hosts" }, () => {
        bb.log.info(
          `hosts changed, interval ${settings.get().intervalSeconds}`,
        );
      });
      return () => off();
    },
  });
}
