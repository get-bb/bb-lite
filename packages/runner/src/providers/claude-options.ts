import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { delimiter, join } from "node:path";
import type {
  McpSdkServerConfigWithInstance,
  ModelInfo,
  Options,
} from "@anthropic-ai/claude-agent-sdk";
import {
  contextSnapshotSchema,
  reasoningEffortsForLevels,
  removeCommandMentionsFromPromptInput,
  type AvailableModel,
  type ContextSnapshot,
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
  type ExecutionOptions,
  type ProviderModels,
  type SessionSpec,
} from "../types.js";
import { BB_MCP_SERVER } from "./claude-tools.js";
import type { SessionHost } from "./provider.js";

type TextInput = Extract<PromptInput, { type: "text" }>;
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };
type ToolCaller = (
  tool: string,
  input: unknown,
  toolUseId: string | undefined,
) => Promise<ToolCallResponse>;

const EXECUTABLE_ENV = "BB_CLAUDE_CODE_EXECUTABLE";
const SKILL_PLUGIN = "bb-global-skills";
const MODEL_ID = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/;
const IMAGE_DATA_URL = /^data:(.+);base64,(.+)$/s;
const PERMISSION_MODES = {
  "accept-edits": "acceptEdits",
  auto: "auto",
  full: "bypassPermissions",
} as const;
const RESERVED_CATEGORIES = ["autocompact buffer", "manual compact buffer"];

const providerOptionsSchema = z.object({
  memoryEnabled: z.boolean().optional(),
  subagentsDisabled: z.boolean().optional(),
  workflowsDisabled: z.boolean().optional(),
  disable1MContext: z.boolean().optional(),
  chromeEnabled: z.boolean().optional(),
  additionalWorkspaceWriteRoots: z.array(z.string()).optional(),
});
const tokens = z.number().int().nonnegative();
const named = z.object({ name: z.string().min(1), tokens });
const flag = z.boolean().default(true);
const contextReportSchema = z.object({
  categories: z.array(named.extend({ isDeferred: z.boolean().default(false) })),
  totalTokens: tokens,
  rawMaxTokens: z.number().int().positive(),
  model: z.string().min(1),
  autoCompactThreshold: z.number().int().positive().optional(),
  isAutoCompactEnabled: z.boolean(),
  memoryFiles: z.array(z.object({ path: z.string(), tokens })).default([]),
  mcpTools: z
    .array(named.extend({ serverName: z.string(), isLoaded: flag }))
    .default([]),
  deferredBuiltinTools: z.array(named.extend({ isLoaded: flag })).default([]),
  systemTools: z.array(named).default([]),
  systemPromptSections: z.array(named).default([]),
  agents: z
    .array(z.object({ agentType: z.string(), source: z.string(), tokens }))
    .default([]),
  skills: z.object({ skillFrontmatter: z.array(named) }).optional(),
  messageBreakdown: z.record(z.string(), tokens).optional(),
});
const MESSAGE_PARTS = {
  "Tool results": "toolResultTokens",
  "Assistant messages": "assistantMessageTokens",
  "User messages": "userMessageTokens",
  "Tool calls": "toolCallTokens",
  Attachments: "attachmentTokens",
  "Redirected context": "redirectedContextTokens",
  Unattributed: "unattributedTokens",
};

function sdkEffort(level: ReasoningLevel) {
  if (level === "ultracode") return "xhigh";
  if (level === "none") return "low";
  return level === "ultra" ? "max" : level;
}

export function claudeSettings(options: ExecutionOptions) {
  const parsed = providerOptionsSchema.safeParse(options.providerOptions);
  const custom = parsed.data ?? {};
  const level = options.reasoningLevel;
  return {
    model: options.model,
    subagents: custom.subagentsDisabled !== true,
    workflows: custom.workflowsDisabled !== true,
    disable1MContext: custom.disable1MContext === true,
    chrome: custom.chromeEnabled === true,
    writableRoots: custom.additionalWorkspaceWriteRoots ?? [],
    baseMode: PERMISSION_MODES[options.permissionMode],
    flags: {
      autoMemoryEnabled: custom.memoryEnabled !== false,
      enableWorkflows: custom.workflowsDisabled !== true,
      effortLevel: sdkEffort(level),
      ultracode: level === "ultracode",
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
  const home = env.HOME?.trim();
  const personal = home ? [".local/bin", ".claude/local"] : [];
  const installed = [
    ...personal.map((dir) => join(home ?? "", dir)),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  const wellKnown = process.getuid?.() === 0 ? [] : installed;
  const onPath = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of [...onPath, ...wellKnown]) {
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
    const manifest = {
      $schema: "https://anthropic.com/claude-code/plugin.schema.json",
      name:
        plugins.length === 0
          ? SKILL_PLUGIN
          : `${SKILL_PLUGIN}-${id.slice(0, 8)}`,
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
  };
  delete env.CLAUDE_AGENT_SDK_CLIENT_APP;
  delete env.ELECTRON_RUN_AS_NODE;
  const { effortLevel: effort, ...flags } = settings.flags;
  const bypass = settings.baseMode === "bypassPermissions";
  const roots = [
    ...new Set([...host.writableRoots, ...settings.writableRoots]),
  ];
  const filesystem = roots.length > 0 ? { allowWrite: roots } : undefined;
  const sandbox = {
    enabled: true,
    failIfUnavailable: false,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: true,
    network: { allowLocalBinding: true },
    ...(filesystem ? { filesystem } : {}),
  };
  const sandboxed = { sandbox, additionalDirectories: roots };
  const executable = await resolveExecutable(env);
  const plugins = await skillPlugins(spec.skillDirs);
  const append = spec.instructions.length > 0 ? spec.instructions : undefined;
  const extraArgs: Record<string, null> = { "replay-user-messages": null };
  if (settings.chrome) extraArgs.chrome = null;
  return {
    cwd: spec.cwd,
    systemPrompt: { type: "preset", preset: "claude_code", append },
    ...(bypass && process.getuid?.() !== 0
      ? { allowDangerouslySkipPermissions: true }
      : {}),
    includePartialMessages: true,
    settingSources: ["user", "project", "local"],
    persistSession: true,
    env,
    ...(bypass ? {} : sandboxed),
    ...(settings.model ? { model: settings.model } : {}),
    effort,
    thinking: { type: "adaptive", display: "summarized" },
    settings: flags,
    ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
    ...(plugins.length > 0 ? { plugins } : {}),
    extraArgs,
  };
}

function slashSkillMentions(entry: TextInput) {
  let { text } = entry;
  for (const { start, end, resource } of entry.mentions) {
    const skill =
      resource.kind === "command" &&
      resource.source === "skill" &&
      resource.trigger === "$" &&
      entry.text.slice(start, end) === `$${resource.name}`;
    if (skill) text = `${text.slice(0, start)}/${text.slice(start + 1)}`;
  }
  return text;
}

export function promptText(input: readonly PromptInput[], planMode: boolean) {
  const plan = { trigger: "/" as const, name: "plan" };
  const items = planMode
    ? removeCommandMentionsFromPromptInput(input, plan)
    : input;
  const onDisk = (path: string) =>
    `It is on disk at ${path} — use the Read tool to view it.]`;
  const chunks = items.flatMap((item) => {
    if (item.type === "text") {
      return item.text.length > 0 ? [slashSkillMentions(item)] : [];
    }
    if (item.type === "image") return [`[Attached image: ${item.url}]`];
    if (item.type === "localImage") {
      return [`[Attached image. ${onDisk(item.path)}`];
    }
    const size =
      item.sizeBytes === undefined ? [] : [`${item.sizeBytes} bytes`];
    const details = [...(item.mimeType ? [item.mimeType] : []), ...size];
    const suffix = details.length > 0 ? ` (${details.join(", ")})` : "";
    const name = item.name ? ` "${item.name}"` : "";
    return [`[Attached file${name}${suffix}. ${onDisk(item.path)}`];
  });
  return chunks.length > 0 ? chunks.join("\n") : undefined;
}

function toolContent(response: ToolCallResponse) {
  const blocks = response.contentItems.flatMap((item): ContentBlock[] => {
    if (item.type === "inputText") {
      return item.text === ""
        ? []
        : [{ type: "text" as const, text: item.text }];
    }
    const [, mimeType, data] = IMAGE_DATA_URL.exec(item.imageUrl) ?? [];
    return mimeType && data
      ? [{ type: "image" as const, data, mimeType }]
      : [{ type: "text" as const, text: item.imageUrl }];
  });
  const fallback = response.success ? "OK" : "Tool call failed";
  return blocks.length > 0
    ? blocks
    : [{ type: "text" as const, text: fallback }];
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
    const response = tools.some((tool) => tool.name === name)
      ? await callTool(name, input, useId).catch((error: unknown) =>
          failed(error instanceof Error ? error.message : String(error)),
        )
      : failed(`Unknown tool: ${name}`);
    const content = toolContent(response);
    return response.success ? { content } : { content, isError: true };
  });
  return { type: "sdk", name: BB_MCP_SERVER, instance };
}

function toModel(info: ModelInfo, model: string, name: string): AvailableModel {
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
    const derived = `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version}${large ? " (1M)" : ""}`;
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
  return {
    models: models.map((m) =>
      m.model === chosen ? { ...m, isDefault: true } : m,
    ),
    selectedOnlyModels: aliases,
  };
}

export function contextSnapshot(
  value: unknown,
  providerSessionId: string,
): ContextSnapshot | undefined {
  const report = contextReportSchema.safeParse(value).data;
  if (report === undefined) return undefined;
  const messages = report.messageBreakdown ?? {};
  const entriesOf = (name: string, deferred: boolean) => {
    const loaded = <T extends { isLoaded: boolean }>(tool: T) =>
      tool.isLoaded !== deferred;
    const lists: Record<string, { name: string; tokens: number }[]> = {
      "system prompt": report.systemPromptSections,
      "system tools": report.systemTools,
      "system tools (deferred)": report.deferredBuiltinTools.filter(loaded),
      "mcp tools": report.mcpTools.filter(loaded).map((tool) => ({
        name: `${tool.serverName}: ${tool.name}`,
        tokens: tool.tokens,
      })),
      "memory files": report.memoryFiles.map((file) => ({
        name: file.path,
        tokens: file.tokens,
      })),
      agents: report.agents.map((agent) => ({
        name: `${agent.agentType} (${agent.source})`,
        tokens: agent.tokens,
      })),
      skills: report.skills?.skillFrontmatter ?? [],
      messages: Object.entries(MESSAGE_PARTS).map(([label, key]) => ({
        name: label,
        tokens: messages[key] ?? 0,
      })),
    };
    const alias = name.replace("custom agents", "agents");
    return lists[alias.replace("mcp tools (deferred)", "mcp tools")] ?? [];
  };
  const occurrence = (seen: Map<string, number>, name: string) => {
    const index = seen.get(name) ?? 0;
    seen.set(name, index + 1);
    return index;
  };
  const categoriesSeen = new Map<string, number>();
  const snapshot = {
    capturedAt: new Date().toISOString(),
    providerSessionId,
    providerTurnId: null,
    model: report.model,
    usedTokens: report.totalTokens,
    contextWindowTokens: report.rawMaxTokens,
    autoCompactAtTokens: report.isAutoCompactEnabled
      ? (report.autoCompactThreshold ?? null)
      : null,
    estimated: true,
    categories: report.categories.map((category) => {
      const name = category.name.toLowerCase();
      const entries = entriesOf(name, category.isDeferred);
      const total = entries.reduce((sum, entry) => sum + entry.tokens, 0);
      const seen = new Map<string, number>();
      const reserved = RESERVED_CATEGORIES.includes(name) ? "reserved" : "used";
      const kind = name === "free space" ? "free" : reserved;
      const index = occurrence(categoriesSeen, category.name);
      return {
        id: JSON.stringify(["claude", category.name, index]),
        label: category.name,
        kind: category.isDeferred ? "deferred" : kind,
        tokens: category.tokens,
        entries: (total > category.tokens ? [] : entries)
          .filter((entry) => entry.tokens > 0)
          .map((entry) => ({
            id: JSON.stringify([entry.name, occurrence(seen, entry.name)]),
            label: entry.name,
            tokens: entry.tokens,
          })),
      };
    }),
  };
  return contextSnapshotSchema.safeParse(snapshot).data;
}
