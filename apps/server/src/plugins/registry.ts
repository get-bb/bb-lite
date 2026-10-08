import { sessions, type Kernel } from "@bb/plugin";
import type * as plugin from "@bb/plugin";
import type { PluginContributionsResponse } from "@bb/server-contract";
import type { Logger } from "@bb/server-kit/context";
import { ApiError, notFound } from "@bb/server-kit/http/errors";
import type { AppBundle } from "./bundle.js";
import { doorCli } from "@bb/server-kit/doors";
import type { PluginInstance } from "./instance.js";
import type { PluginManifest } from "./manifest.js";

export interface PluginRecord {
  manifest: PluginManifest;
  server: plugin.PluginServerEntry | null;
  external: boolean;
  watch: boolean;
  configEnabled: boolean;
  instance: PluginInstance | null;
  app: AppBundle | null;
  error: string | null;
  token: string | null;
}

export class PluginRegistry {
  protected readonly records = new Map<string, PluginRecord>();

  constructor(
    protected readonly log: Logger,
    protected readonly kernel: Kernel,
  ) {}

  record(id: string): PluginRecord {
    const record = this.records.get(id);
    if (record === undefined) throw notFound(`Unknown plugin "${id}"`);
    return record;
  }

  running(id: string): PluginInstance {
    const { instance, error } = this.record(id);
    if (instance !== null) return instance;
    const reason = error === null ? "" : `: ${error}`;
    const message = `Plugin "${id}" is not running${reason}`;
    throw new ApiError(503, "plugin_unavailable", message);
  }

  cliOf(id: string): plugin.CliRegistration | null {
    const { instance, manifest } = this.record(id);
    if (instance === null) return null;
    const { description } = manifest;
    return instance.cli ?? doorCli(this.kernel, id, description);
  }

  skillDirs(): string[] {
    return [...this.records.values()].flatMap((record) =>
      record.instance === null ? [] : record.manifest.skillDirs,
    );
  }

  contributions(): PluginContributionsResponse {
    const active = this.active();
    return {
      cliCommands: active.flatMap(([pluginId]) => {
        const cli = this.cliOf(pluginId);
        if (cli === null) return [];
        const { name, summary, commands = [] } = cli;
        return [{ pluginId, name, summary, commands }];
      }),
      mentionProviders: this.kernel
        .entries(sessions.mention)
        .map(({ plugin: pluginId, item: { id, label, triggers = ["@"] } }) => {
          return { pluginId, id, label, triggers: [...triggers] };
        }),
    };
  }

  private active(): [id: string, instance: PluginInstance][] {
    return [...this.records].flatMap(([id, { instance }]) =>
      instance === null ? [] : [[id, instance]],
    );
  }
}
