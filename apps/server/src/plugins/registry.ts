import type { DynamicTool, ToolCallResponse } from "@bb/domain";
import {
  machines,
  pluginEventDefs,
  server,
  sessions,
  type EventDef,
  type Kernel,
} from "@bb/plugin";
import type * as plugin from "@bb/plugin";
import type {
  PluginContributionsResponse,
  PluginMentionGroup,
} from "@bb/server-contract";
import type { Logger } from "@bb/server-kit/context";
import { ApiError, notFound } from "@bb/server-kit/http/errors";
import type { AppBundle } from "./bundle.js";
import { callDoorTool, doorCli, doorTools } from "@bb/server-kit/doors";
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

function toolResponse(text: string, success: boolean): ToolCallResponse {
  return { contentItems: [{ type: "inputText", text }], success };
}

export class PluginRegistry {
  protected readonly records = new Map<string, PluginRecord>();
  titleFallback: plugin.TitleFallback | null = null;

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

  async instructionsFor(context: plugin.ThreadContext): Promise<string> {
    const sections = await this.kernel.call(sessions.instructions, context);
    return sections.map(({ text }) => text).join("\n\n");
  }

  toolsFor(context: plugin.ThreadContext): DynamicTool[] {
    return doorTools(this.kernel, context);
  }

  cliOf(id: string): plugin.CliRegistration | null {
    const { instance, manifest } = this.record(id);
    if (instance === null) return null;
    const { description } = manifest;
    return instance.cli ?? doorCli(this.kernel, id, description);
  }

  async callTool(
    name: string,
    input: unknown,
    context: plugin.ThreadContext & { signal: AbortSignal },
  ): Promise<ToolCallResponse> {
    const answered = await callDoorTool(this.kernel, name, input, context);
    return answered ?? toolResponse(`Unknown tool "${name}"`, false);
  }

  async contributedEnv(
    providerId: string,
    context: plugin.ThreadContext,
  ): Promise<plugin.ProviderEnvEntry[]> {
    return this.kernel.call(sessions.env, { ...context, providerId });
  }

  emit<Name extends keyof plugin.PluginEvents>(
    name: Name,
    payload: plugin.PluginEvents[Name],
  ): void {
    const event: EventDef = pluginEventDefs[name];
    this.kernel.emit(event, payload);
  }

  async searchMentions(
    query: plugin.MentionQuery,
  ): Promise<PluginMentionGroup[]> {
    const groups: PluginMentionGroup[] = [];
    const sources =
      query.query === "" ? [] : this.kernel.entries(sessions.mention);
    for (const { plugin: pluginId, item: provider } of sources) {
      if (!(provider.triggers ?? ["@"]).includes(query.trigger)) continue;
      const search = provider.search.bind(provider);
      const found = await this.attempt(pluginId, "mentions", search, query);
      if (found === undefined || found.length === 0) continue;
      const items = found.map((item) => ({
        itemId: `${provider.id}:${item.id}`,
        title: item.title,
        subtitle: item.subtitle ?? null,
        icon: item.icon ?? null,
      }));
      const { id: providerId, label } = provider;
      groups.push({ pluginId, providerId, label, items });
    }
    return groups;
  }

  async resolveMention(pluginId: string, itemId: string): Promise<string> {
    const [providerId, ...rest] = itemId.split(":");
    this.running(pluginId);
    const found = this.kernel
      .entries(sessions.mention)
      .find(
        ({ plugin, item }) => plugin === pluginId && item.id === providerId,
      );
    if (found === undefined) {
      throw notFound(`Unknown mention provider "${providerId}"`);
    }
    return (await found.item.resolve(rest.join(":"))).context;
  }

  async generateTitle(
    prompt: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    const services = this.kernel.entries(sessions.inference);
    for (const { plugin: id, item: service } of services) {
      const complete = service.complete.bind(service, prompt, { signal });
      const text = await this.attempt(id, "inference", complete, undefined);
      if (text !== undefined && text.trim() !== "") return text.trim();
    }
    const fallback =
      this.titleFallback ?? this.kernel.pick(sessions.titleFallback);
    if (services.length > 0 || fallback === null) return null;
    const title = (task: string) => fallback(task, signal);
    return (await this.attempt("core", "title", title, prompt)) ?? null;
  }

  publicUrl(): string | null {
    return this.kernel.pick(server.publicUrl)?.() ?? null;
  }

  machineAccess(): plugin.MachineAccessProvider | null {
    return this.kernel.pick(machines.access);
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

  private async attempt<Argument, Result>(
    pluginId: string,
    surface: string,
    call: (argument: Argument) => Result | Promise<Result>,
    argument: Argument,
  ): Promise<Result | undefined> {
    try {
      return await call(argument);
    } catch (error) {
      this.log.warn(`Plugin ${surface} failed`, { pluginId, err: error });
      return undefined;
    }
  }
}
