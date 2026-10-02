import type { DynamicTool, ToolCallResponse } from "@bb/domain";
import type {
  AgentTool,
  MachineAccessProvider,
  MentionQuery,
  PluginEvents,
  PluginServerEntry,
  ProviderEnvEntry,
  ThreadContext,
} from "@bb/plugin";
import type {
  PluginContributionsResponse,
  PluginMentionGroup,
} from "@bb/server-contract";
import { z } from "zod";
import type { Logger } from "../context.js";
import { ApiError, errorMessage, notFound } from "../http/errors.js";
import type { AppBundle } from "./bundle.js";
import type { PluginInstance } from "./instance.js";
import type { PluginManifest } from "./manifest.js";

export interface PluginRecord {
  manifest: PluginManifest;
  server: PluginServerEntry | null;
  external: boolean;
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

  constructor(protected readonly log: Logger) {}

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

  async instructionsFor(context: ThreadContext): Promise<string> {
    const parts: (string | null | undefined)[] = [];
    for (const [id, instance] of this.active()) {
      for (const tool of this.tools(instance, context)) {
        parts.push(tool.instructions);
      }
      for (const contribute of instance.instructions) {
        parts.push(await this.attempt(id, "instructions", contribute, context));
      }
    }
    return parts.filter((part) => part?.trim()).join("\n\n");
  }

  toolsFor(context: ThreadContext): DynamicTool[] {
    return this.active().flatMap(([, instance]) =>
      this.tools(instance, context).map((tool) => {
        const { name, description, presentation, parameters } = tool;
        const inputSchema = z.toJSONSchema(parameters);
        const base = { name, description, inputSchema };
        return presentation === undefined ? base : { ...base, presentation };
      }),
    );
  }

  async callTool(
    name: string,
    input: unknown,
    context: ThreadContext & { signal: AbortSignal },
  ): Promise<ToolCallResponse> {
    const tool = this.active()
      .flatMap(([, instance]) => this.tools(instance, context))
      .find((candidate) => candidate.name === name);
    if (tool === undefined)
      return toolResponse(`Unknown tool "${name}"`, false);
    const parsed = await tool.parameters.safeParseAsync(input);
    if (!parsed.success) {
      return toolResponse(`Invalid arguments: ${parsed.error.message}`, false);
    }
    try {
      const result = await tool.execute(parsed.data, context);
      return typeof result === "string"
        ? toolResponse(result, true)
        : toolResponse(result.text, !result.isError);
    } catch (error) {
      this.log.warn("Plugin tool failed", { tool: name, err: error });
      return toolResponse(`Tool failed: ${errorMessage(error)}`, false);
    }
  }

  async contributedEnv(
    providerId: string,
    context: ThreadContext,
  ): Promise<ProviderEnvEntry[]> {
    const entries: ProviderEnvEntry[] = [];
    for (const [id, instance] of this.active()) {
      for (const [contributorProviderId, contribute] of instance.env) {
        if (contributorProviderId !== providerId) continue;
        const added = await this.attempt(id, "env", contribute, context);
        entries.push(...(added ?? []));
      }
    }
    return entries;
  }

  emit<Name extends keyof PluginEvents>(
    name: Name,
    payload: PluginEvents[Name],
  ): void {
    for (const [id, instance] of this.active()) {
      for (const [listened, handler] of instance.listeners) {
        if (listened !== name) continue;
        void this.attempt(id, `${name} handler`, handler, payload);
      }
    }
  }

  async searchMentions(query: MentionQuery): Promise<PluginMentionGroup[]> {
    const groups: PluginMentionGroup[] = [];
    const sources = query.query === "" ? [] : this.active();
    for (const [pluginId, instance] of sources) {
      for (const provider of instance.mentionProviders) {
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
    }
    return groups;
  }

  async resolveMention(pluginId: string, itemId: string): Promise<string> {
    const [providerId, ...rest] = itemId.split(":");
    const provider = this.running(pluginId).mentionProviders.find(
      (candidate) => candidate.id === providerId,
    );
    if (provider === undefined) {
      throw notFound(`Unknown mention provider "${providerId}"`);
    }
    return (await provider.resolve(rest.join(":"))).context;
  }

  async generateTitle(
    prompt: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    for (const [id, instance] of this.active()) {
      for (const service of instance.inference) {
        const complete = service.complete.bind(service, prompt, { signal });
        const text = await this.attempt(id, "inference", complete, undefined);
        if (text !== undefined && text.trim() !== "") return text.trim();
      }
    }
    return null;
  }

  publicUrl(): string | null {
    return this.firstSet((instance) => instance.publicUrl);
  }

  machineAccess(): MachineAccessProvider | null {
    return this.firstSet((instance) => instance.machineAccess);
  }

  skillDirs(): string[] {
    return [...this.records.values()].flatMap((record) =>
      record.instance === null ? [] : record.manifest.skillDirs,
    );
  }

  contributions(): PluginContributionsResponse {
    const active = this.active();
    return {
      cliCommands: active.flatMap(([pluginId, { cli }]) => {
        if (cli === null) return [];
        const { name, summary, commands = [] } = cli;
        return [{ pluginId, name, summary, commands }];
      }),
      mentionProviders: active.flatMap(([pluginId, instance]) =>
        instance.mentionProviders.map(({ id, label, triggers = ["@"] }) => {
          return { pluginId, id, label, triggers: [...triggers] };
        }),
      ),
    };
  }

  private active(): [id: string, instance: PluginInstance][] {
    return [...this.records].flatMap(([id, { instance }]) =>
      instance === null ? [] : [[id, instance]],
    );
  }

  private firstSet<T>(pick: (instance: PluginInstance) => T | null): T | null {
    for (const [, instance] of this.active()) {
      const value = pick(instance);
      if (value !== null) return value;
    }
    return null;
  }

  private tools(instance: PluginInstance, context: ThreadContext): AgentTool[] {
    return instance.tools.filter(
      (tool) => tool.enabledFor?.(context) !== false,
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
