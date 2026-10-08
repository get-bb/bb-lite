import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { delimiter, join } from "node:path";
import type {
  McpSdkServerConfigWithInstance,
  ModelInfo,
  Options,
  PermissionMode,
} from "@anthropic-ai/claude-agent-sdk";
import {
  reasoningEffortsForLevels,
  type AvailableModel,
  type DynamicTool,
  type PromptInput,
  type ReasoningLevel,
  type ToolCallResponse,
} from "@bb/domain";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  RunnerError,
  type CustomModelSettings,
  type ExecutionOptions,
  type ProviderModels,
  type SessionSpec,
} from "@bb/runner";
import { BB_MCP_SERVER } from "./claude-tools.js";
import type { SessionHost } from "@bb/runner";

type ToolCaller = (
  tool: string,
  input: unknown,
  toolUseId: string | undefined,
) => Promise<ToolCallResponse>;

const EXECUTABLE_ENV = "BB_CLAUDE_CODE_EXECUTABLE";
const SKILL_PLUGIN = "bb-global-skills";
const MODEL_ID = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/;
const PERMISSION_MODES = {
  "accept-edits": "acceptEdits",
  auto: "auto",
  full: "bypassPermissions",
} as const;

const providerOptionsSchema = z.object({
  memoryEnabled: z.boolean().optional(),
  subagentsDisabled: z.boolean().optional(),
  workflowsDisabled: z.boolean().optional(),
  disable1MContext: z.boolean().optional(),
  chromeEnabled: z.boolean().optional(),
  additionalWorkspaceWriteRoots: z.array(z.string()).optional(),
});

function sdkEffort(level: ReasoningLevel) {
  if (level === "ultracode") return "xhigh";
  if (level === "none") return "low";
  return level === "ultra" ? "max" : level;
}

export function startMode(mode: PermissionMode): PermissionMode {
  const refused = mode === "bypassPermissions" && process.getuid?.() === 0;
  return refused ? "default" : mode;
}

export function claudeSettings(
  options: ExecutionOptions,
  customModels: readonly CustomModelSettings[] = [],
) {
  const parsed = providerOptionsSchema.safeParse(options.providerOptions);
  const custom = parsed.data ?? {};
  const customModel = customModels.find(({ model }) => model === options.model);
  const disable1MContext = custom.disable1MContext === true;
  const chrome = custom.chromeEnabled === true;
  const writableRoots = custom.additionalWorkspaceWriteRoots ?? [];
  const baseMode = PERMISSION_MODES[options.permissionMode];
  return {
    model: options.model,
    subagents: custom.subagentsDisabled !== true,
    workflows: custom.workflowsDisabled !== true,
    disable1MContext,
    chrome,
    writableRoots,
    baseMode,
    customModel,
    fixed: [
      baseMode,
      disable1MContext,
      chrome,
      writableRoots,
      ...(customModel ? [customModel] : []),
    ],
    flags: {
      autoMemoryEnabled: custom.memoryEnabled !== false,
      enableWorkflows: custom.workflowsDisabled !== true,
      effortLevel: sdkEffort(options.reasoningLevel),
      ultracode: options.reasoningLevel === "ultracode",
      fastMode: options.serviceTier === "fast",
    },
  };
}
export type ClaudeSettings = ReturnType<typeof claudeSettings>;

async function isExecutable(path: string) {
  const runnable = fs.access(path, constants.X_OK).then(() => fs.stat(path));
  return runnable.then((info) => info.isFile()).catch(() => false);
}

export async function resolveExecutable(env: Record<string, string>) {
  const explicit = process.env[EXECUTABLE_ENV]?.trim();
  if (explicit) {
    if (await isExecutable(explicit)) return explicit;
    const message = `${EXECUTABLE_ENV} must point to an executable Claude CLI path: ${explicit}`;
    throw new RunnerError("missing_executable", message);
  }
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, "claude");
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

async function skillPlugins(skillDirs: string[]) {
  const root = join(tmpdir(), `bb-claude-skill-plugins-${userInfo().uid}`);
  const plugins: { type: "local"; path: string }[] = [];
  for (const dir of new Set(skillDirs)) {
    const id = createHash("sha256").update(dir).digest("hex").slice(0, 16);
    const path = join(root, id);
    const link = join(path, "skills");
    const suffix = plugins.length === 0 ? "" : `-${id.slice(0, 8)}`;
    const manifest = {
      $schema: "https://anthropic.com/claude-code/plugin.schema.json",
      name: `${SKILL_PLUGIN}${suffix}`,
      version: "0.1.0",
      description: `Skills injected by bb (${dir}).`,
      author: { name: "bb" },
      skills: "./skills",
    };
    const linked = async () =>
      (await fs.readlink(link).catch(() => null)) === dir;
    const assemble = async () => {
      await fs.mkdir(join(path, ".claude-plugin"), { recursive: true });
      const file = join(path, ".claude-plugin", "plugin.json");
      await fs.writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
      if (await linked()) return;
      await fs.rm(link, { recursive: true, force: true });
      await fs.symlink(dir, link, "dir");
    };
    await assemble().catch(() => undefined);
    if (await linked()) plugins.push({ type: "local", path });
  }
  return plugins;
}

export async function buildQueryOptions(
  spec: SessionSpec,
  settings: ClaudeSettings,
  host: SessionHost,
): Promise<Options> {
  const env: Record<string, string> = {
    ...host.processEnv,
    ...host.env,
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_CODE_DISABLE_1M_CONTEXT: settings.disable1MContext ? "1" : "0",
    ...settings.customModel?.env,
  };
  for (const name of settings.customModel?.unsetEnv ?? []) delete env[name];
  delete env.CLAUDE_AGENT_SDK_CLIENT_APP;
  delete env.ELECTRON_RUN_AS_NODE;
  const { effortLevel: effort, ...flags } = settings.flags;
  const bypass = settings.baseMode === "bypassPermissions";
  const writable = [...host.writableRoots, ...settings.writableRoots];
  const roots = [...new Set(writable)];
  const sandbox = {
    enabled: true,
    failIfUnavailable: false,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: true,
    network: { allowLocalBinding: true },
    ...(roots.length > 0 ? { filesystem: { allowWrite: roots } } : {}),
  };
  const executable = await resolveExecutable(env);
  const plugins = await skillPlugins(spec.skillDirs);
  const append = spec.instructions || undefined;
  const extraArgs: Record<string, null> = { "replay-user-messages": null };
  if (settings.chrome) extraArgs.chrome = null;
  const unsafe = startMode(settings.baseMode) === "bypassPermissions";
  return {
    cwd: spec.cwd,
    systemPrompt: { type: "preset", preset: "claude_code", append },
    ...(unsafe ? { allowDangerouslySkipPermissions: true } : {}),
    includePartialMessages: true,
    disallowedTools: ["EnterPlanMode", "ExitPlanMode"],
    settingSources: ["user", "project", "local"],
    persistSession: true,
    env,
    ...(bypass ? {} : { sandbox, additionalDirectories: roots }),
    ...(settings.model ? { model: settings.model } : {}),
    effort,
    thinking: { type: "adaptive", display: "summarized" },
    settings: flags,
    ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
    ...(plugins.length > 0 ? { plugins } : {}),
    extraArgs,
  };
}

export function promptText(input: readonly PromptInput[]) {
  const onDisk = (path: string) =>
    `It is on disk at ${path} — use the Read tool to view it.]`;
  const chunks = input.flatMap((item) => {
    if (item.type === "image") return [`[Attached image: ${item.url}]`];
    if (item.type === "localImage") {
      return [`[Attached image. ${onDisk(item.path)}`];
    }
    if (item.type === "localFile") {
      const size =
        item.sizeBytes === undefined ? "" : `${item.sizeBytes} bytes`;
      const details = [item.mimeType, size].filter(Boolean).join(", ");
      const name = item.name ? ` "${item.name}"` : "";
      const suffix = details ? ` (${details})` : "";
      return [`[Attached file${name}${suffix}. ${onDisk(item.path)}`];
    }
    let { text } = item;
    for (const { start, end, resource } of item.mentions) {
      const skill =
        resource.kind === "command" &&
        resource.source === "skill" &&
        resource.trigger === "$" &&
        item.text.slice(start, end) === `$${resource.name}`;
      if (skill) text = `${text.slice(0, start)}/${text.slice(start + 1)}`;
    }
    return text.length > 0 ? [text] : [];
  });
  return chunks.length > 0 ? chunks.join("\n") : undefined;
}

function toolContent(response: ToolCallResponse) {
  const texts = response.contentItems.map((item) =>
    item.type === "inputText" ? item.text : item.imageUrl,
  );
  const fallback = response.success ? "OK" : "Tool call failed";
  const shown = texts.filter(Boolean);
  const blocks = shown.length > 0 ? shown : [fallback];
  return blocks.map((text) => ({ type: "text" as const, text }));
}

export function bbToolServer(
  tools: DynamicTool[],
  callTool: ToolCaller,
): McpSdkServerConfigWithInstance {
  const info = { name: BB_MCP_SERVER, version: "1.0.0" };
  const instance = new McpServer(info, { capabilities: { tools: {} } });
  const isObject = z.looseObject({ type: z.literal("object") });
  instance.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map(({ name, description, inputSchema }) => {
      const schema = isObject.safeParse(inputSchema).data;
      return { name, description, inputSchema: schema ?? { type: "object" } };
    }),
  }));
  instance.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: input = {}, _meta: meta } = request.params;
    const toolUseId = meta?.["claudecode/toolUseId"];
    const useId = typeof toolUseId === "string" ? toolUseId : undefined;
    const failed = (text: string): ToolCallResponse => ({
      contentItems: [{ type: "inputText", text }],
      success: false,
    });
    const describe = (error: unknown) =>
      failed(error instanceof Error ? error.message : String(error));
    const response = tools.some((tool) => tool.name === name)
      ? await callTool(name, input, useId).catch(describe)
      : failed(`Unknown tool: ${name}`);
    const content = toolContent(response);
    return response.success ? { content } : { content, isError: true };
  });
  return { type: "sdk", name: BB_MCP_SERVER, instance };
}

function toModel(info: ModelInfo, model: string, name: string) {
  const levels = (info.supportedEffortLevels ?? []).flatMap(
    (level): ReasoningLevel[] =>
      level === "xhigh" ? ["xhigh", "ultracode"] : [level],
  );
  const efforts: ReasoningLevel[] = levels.length > 0 ? levels : ["low"];
  const preferred = (["high", "medium"] as const).find((level) =>
    efforts.includes(level),
  );
  return {
    id: model,
    model,
    displayName: name,
    description: info.description,
    supportedReasoningEfforts: reasoningEffortsForLevels(efforts),
    defaultReasoningEffort: preferred ?? efforts[0] ?? "low",
    isDefault: false,
  };
}

export function buildModels(discovered: readonly ModelInfo[]): ProviderModels {
  const isDefault = (info: ModelInfo) => info.value === "default";
  const ordered = [
    ...discovered.filter((info) => !isDefault(info)),
    ...discovered.filter(isDefault),
  ];
  const models: AvailableModel[] = [];
  const aliases: AvailableModel[] = [];
  const known = (list: AvailableModel[], model: string) =>
    list.some((candidate) => candidate.model === model);
  for (const info of ordered) {
    const model = info.resolvedModel ?? info.value;
    if (known(models, model)) continue;
    const [, family = "", major, minor, large] = MODEL_ID.exec(model) ?? [];
    const version = minor === undefined ? major : `${major}.${minor}`;
    const brand = `${family.charAt(0).toUpperCase()}${family.slice(1)}`;
    const derived = `${brand} ${version}${large ? " (1M)" : ""}`;
    models.push(toModel(info, model, family ? derived : info.displayName));
  }
  for (const info of discovered) {
    const alias = info.value;
    const offered = known(models, alias) || known(aliases, alias);
    if (isDefault(info) || offered) continue;
    aliases.push(toModel(info, alias, `${info.displayName} alias`));
  }
  const resolved = discovered.find(isDefault)?.resolvedModel ?? "";
  const chosen = known(models, resolved) ? resolved : models[0]?.model;
  const marked = models.map((model) => ({
    ...model,
    isDefault: model.model === chosen,
  }));
  return { models: marked, selectedOnlyModels: aliases };
}
