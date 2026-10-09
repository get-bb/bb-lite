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
  manifestError: string | null;
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
    const doors = doorCli(this.kernel, id, manifest.description);
    const own = instance.cli;
    if (own === null || doors === null) return own ?? doors;
    const offered = doors.commands ?? [];
    const first = new Set(offered.map(({ name }) => name.split(" ")[0]));
    const commands = [...(own.commands ?? []), ...offered];
    const listing = { name: own.name, summary: own.summary, commands };
    return {
      ...listing,
      run: (argv, context) => {
        if (first.has(argv[0])) return doors.run(argv, context);
        const top = argv.length === 0 || argv[0].startsWith("-");
        const help = argv.includes("--help") || argv.includes("-h");
        if (top && help) return { exitCode: 0, stdout: mergedHelp(listing) };
        return own.run(argv, context);
      },
    };
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

function mergedHelp({
  name,
  summary,
  commands,
}: {
  name: string;
  summary: string;
  commands: { name: string; summary: string }[];
}): string {
  const rows = commands
    .map((command) => [`bb ${name} ${command.name}`, command.summary])
    .sort(([a], [b]) => a.localeCompare(b));
  const width = Math.max(...rows.map(([left]) => left.length));
  return [
    `bb ${name} — ${summary}`,
    "",
    `Usage:\n  bb ${name} <command> [options]`,
    "",
    "Commands:",
    ...rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`),
    "",
    `Run \`bb ${name} <command> --help\` for arguments and options.`,
    "",
  ].join("\n");
}
