import type { PluginServerApi } from "@bb/plugin";
import type { ServerContext } from "@bb/server-kit/context";

export type PluginOutwardApi = Pick<PluginServerApi, "machine">;

export type PluginHostDeps = (pluginId: string) => PluginOutwardApi;

export function createPluginHostDeps(ctx: ServerContext): PluginHostDeps {
  return () => ({
    machine: (hostId) => ({
      async call(op, input) {
        const parsed: unknown = await op.input.parseAsync(input);
        const runner = ctx.runners.get(hostId);
        const result = await runner.callOp({ name: op.name, input: parsed });
        return (await op.output.parseAsync(result)) as never;
      },
    }),
  });
}
