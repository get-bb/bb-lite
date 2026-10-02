import {
  THREAD_EVENT_ITEM_PRESENTATION_DETAIL_MAX_LENGTH as DETAIL_MAX_LENGTH,
  type ThreadEventItemPresentation as Presentation,
  type ThreadEventPlanStep as PlanStep,
} from "@bb/domain";
import { z } from "zod";
import type { ItemShape } from "../events/event-builder.js";
import * as ui from "./provider.js";

export interface ClassifiedTool {
  shape: ItemShape;
  presentation: Presentation;
  planSteps?: PlanStep[];
}

export interface ToolContext {
  injected: ReadonlyMap<string, Presentation | undefined>;
  sandboxed: boolean;
}

interface PlanTask {
  subject: string;
  activeForm: string | null;
  status: z.infer<typeof taskStatus>;
}
export type TaskPlan = Map<string, PlanTask>;
type Args = Record<string, unknown>;

export const BB_MCP_SERVER = "bb-bridge";
const [ADD, UPDATE, CONTENT, PATH] = [
  "add",
  "update",
  "content",
  "path",
] as const;
const NO_OUTPUT = "(Bash completed with no output)";
const MCP_TOOL = /^mcp__(.+?)__(.+)$/;
const SANDBOX_BADGE = {
  glyph: "SquareUnlock02",
  label: "Outside of sandbox",
  hint: "Outside of sandbox",
  tone: "destructive" as const,
};
const BUILTIN_TOOLS = `
TodoWrite|Updating todos|Updated todos|ListTodo|hide
TaskCreate|Creating task|Created task|ListTodo|hide|subject
TaskUpdate|Updating task|Updated task|ListTodo|hide|subject
TaskList|Listing tasks|Listed tasks|ListTodo|hide
TaskGet|Reading task|Read task|ListTodo|hide
ToolSearch|Searching tools|Searched tools|Toolbox|hide|query
TaskOutput|Reading task output|Read task output|Terminal|hide
Monitor|Monitoring|Monitored|Eye|hide|command
ScheduleWakeup|Scheduling wake-up|Scheduled wake-up|Clock|hide|reason
SendMessage|Messaging agent|Messaged agent|Sent|hide|to
AskUserQuestion|Asking a question|Asked a question|MessageQuestion|hide
EnterPlanMode|Entering plan mode|Entered plan mode|ListTodo
ExitPlanMode|Presenting plan|Presented plan|FileText
Workflow|Starting workflow|Started workflow|Workflow
TaskStop|Stopping task|Stopped task|Terminal
ListAgents|Listing agents|Listed agents|UserRound
Skill|Loading skill|Loaded skill|Zap||skill
StructuredOutput|Returning structured output|Returned structured output|Code
EnterWorktree|Entering worktree|Entered worktree|GitBranch
ExitWorktree|Leaving worktree|Left worktree|GitBranch
LS|Listing directory|Listed directory|FolderOpen||path`;
const builtinTools = new Map(
  BUILTIN_TOOLS.trim()
    .split("\n")
    .map((row) => row.split("|"))
    .map(([tool = "", ...spec]) => [tool, spec]),
);
const FILE_VERBS: Record<string, [string, string] | undefined> = {
  Edit: ["Editing file", "Edited file"],
  MultiEdit: ["Editing file", "Edited file"],
  Write: ["Writing file", "Wrote file"],
  NotebookEdit: ["Editing notebook", "Edited notebook"],
};
const PLAN_STATUS: Record<string, PlanStep["status"]> = {
  pending: "pending",
  in_progress: "active",
  completed: "completed",
};

export const fields = z.record(z.string(), z.unknown());
const editsSchema = z.array(
  z.object({ old_string: z.string(), new_string: z.string() }),
);
const todosSchema = z.array(
  z.looseObject({ content: z.string(), status: z.string() }),
);
const taskStatus = z.enum(["pending", "in_progress", "completed"]);
const taskSchema = z.object({
  id: z.string(),
  subject: z.string(),
  status: taskStatus.optional().catch(undefined),
});

export function text(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function toRecord(value: unknown) {
  return fields.safeParse(value).data;
}

function made(shape: ItemShape, presentation: Presentation): ClassifiedTool {
  return { shape, presentation };
}

export function genericTool(tool: string, input: unknown): ClassifiedTool {
  const [pending, completed, glyph = "", hide, field] =
    builtinTools.get(tool) ?? [];
  const title = field ? text(toRecord(input)?.[field]) : undefined;
  const known = ui.presentation(pending ?? "", completed ?? "", glyph, title);
  const listed = hide ? { ...known, suppress: true } : known;
  const presentation = pending === undefined ? ui.labels.tool(tool) : listed;
  const shape = { type: "toolCall" as const, tool };
  return made({ ...shape, arguments: toRecord(input) }, presentation);
}

function fileChange(tool: string, args: Args, input: unknown): ClassifiedTool {
  const notebook = tool === "NotebookEdit";
  const path = notebook
    ? text(args.notebook_path)
    : (text(args.file_path) ?? text(args.path));
  const [pending = "", completed = ""] = FILE_VERBS[tool] ?? [];
  const name = path ? ui.fileName(path) : undefined;
  const presentation = ui.presentation(pending, completed, "EditFile", name);
  if (notebook && path === undefined) return genericTool(tool, input);
  if (!notebook && !path) return { ...genericTool(tool, input), presentation };
  const file = path ?? "";
  const change = (before: string | undefined, after: string | undefined) => ({
    path: file,
    kind: before === undefined && !notebook ? ADD : UPDATE,
    diff:
      after === undefined ? undefined : ui.buildEditDiff(file, before, after),
  });
  const edits = editsSchema.safeParse(args.edits).data;
  const written = text(args.new_string) ?? text(args.content);
  const single = notebook
    ? change(undefined, text(args.new_source))
    : change(text(args.old_string), written);
  const changes =
    tool === "MultiEdit" && edits !== undefined
      ? edits.map((edit) => change(edit.old_string, edit.new_string))
      : [single];
  return made({ type: "fileChange", changes }, presentation);
}

function delegation(tool: string, id: string, args: Args): ClassifiedTool {
  const [type, model] = [text(args.subagent_type), text(args.model)];
  const firstLine = text(args.prompt)?.split("\n", 1)[0]?.trim();
  const label = text(args.description) ?? firstLine ?? type ?? tool;
  const background = args.run_in_background === true;
  const [pending, completed] = background
    ? ["Launching subagent", "Launched subagent"]
    : ["Running subagent", "Subagent finished"];
  const base = ui.presentation(pending, completed, "UserRound", label);
  const parts = [type && `${type} agent`, model && `model ${model}`];
  const stated = parts.filter(Boolean).join(" · ");
  const detail = ui.ellipsize(stated, DETAIL_MAX_LENGTH);
  const shape = { type: "delegation" as const, childRef: id, label };
  return made({ ...shape, background }, detail ? { ...base, detail } : base);
}

export function parseBashCommand(input: unknown) {
  const args = toRecord(input);
  const command = text(args?.command);
  return command ? { command, cwd: text(args?.cwd) ?? null } : undefined;
}

function bashCommand(args: Args, sandboxed: boolean) {
  const bash = parseBashCommand(args);
  if (bash === undefined) return undefined;
  const [pending, completed] =
    args.run_in_background === true
      ? ["Starting background command", "Started background command"]
      : ["Running command", "Ran command"];
  const base = ui.presentation(pending, completed, "Terminal", bash.command);
  const escaped = sandboxed && args.dangerouslyDisableSandbox === true;
  const shape = { type: "commandExecution" as const, command: bash.command };
  const presentation = escaped ? { ...base, badge: SANDBOX_BADGE } : base;
  return made({ ...shape, cwd: bash.cwd ?? "" }, presentation);
}

function todoPlanSteps(todos: unknown): PlanStep[] | undefined {
  return todosSchema.safeParse(todos).data?.flatMap((todo) => {
    const status = PLAN_STATUS[todo.status];
    const doing = status === "active" ? text(todo.activeForm) : undefined;
    const step = (doing ?? todo.content).trim();
    return status === undefined || step === "" ? [] : [{ step, status }];
  });
}

export function classifyTool(
  tool: string,
  id: string,
  input: unknown,
  context: ToolContext,
): ClassifiedTool {
  const args = toRecord(input) ?? {};
  const path = text(args.file_path) ?? text(args.path);
  const [pattern, query, url] = [args.pattern, args.query, args.url].map(text);
  const mode = tool === "Grep" ? CONTENT : PATH;
  const search = { type: "search" as const, mode, path: path || undefined };
  const fetch = { url: url ?? "", prompt: text(args.prompt) ?? null };
  const bash = tool === "Bash" && bashCommand(args, context.sandboxed);
  const [, server, mcpTool] = MCP_TOOL.exec(tool) ?? [];
  const searches = tool === "Grep" || tool === "Glob";
  if (bash) return bash;
  if (tool === "Read" && path) {
    return made({ type: "fileRead", path }, ui.labels.fileRead(path));
  }
  if (searches && pattern) {
    const presentation = ui.labels.search(mode, pattern);
    return made({ ...search, query: pattern }, presentation);
  }
  if (FILE_VERBS[tool] !== undefined) return fileChange(tool, args, input);
  if (tool === "WebSearch" && query) {
    const shape = { type: "webSearch" as const, queries: [query] };
    return made({ ...shape, resultText: null }, ui.labels.webSearch(query));
  }
  if (tool === "WebFetch" && url) {
    const shape = { type: "webFetch" as const, ...fetch, pattern: null };
    return made({ ...shape, resultText: null }, ui.labels.webFetch(url));
  }
  if (tool === "Agent" || tool === "Task") return delegation(tool, id, args);
  if (tool === "TodoWrite") {
    const planSteps = todoPlanSteps(args.todos);
    return { ...genericTool(tool, input), planSteps };
  }
  if (!server || !mcpTool) return genericTool(tool, input);
  const fromBb = server === BB_MCP_SERVER;
  const generic = ui.labels.tool(mcpTool);
  const injected = context.injected.get(mcpTool) ?? generic;
  const shape = { type: "toolCall" as const, tool: mcpTool };
  return made(
    { ...shape, server: fromBb ? "bb" : server, arguments: toRecord(input) },
    fromBb ? injected : { ...generic, title: server },
  );
}

export function resultText(content: unknown): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    const nested = toRecord(content)?.content;
    return Array.isArray(nested) ? resultText(nested) : JSON.stringify(content);
  }
  const parsed: (Args | undefined)[] = content.map(toRecord);
  const blocks = parsed.filter((block) => block !== undefined);
  const references = blocks.map(
    (block) => block.type === "tool_reference" && text(block.tool_name),
  );
  if (references.length > 0 && references.every(Boolean)) {
    return `Matched tools: ${references.join(", ")}`;
  }
  const described = blocks.flatMap((block) => {
    const { type, path, tool_name: tool, url, imageUrl } = block;
    const target = text(path) || text(tool) || text(url) || text(imageUrl);
    if (type === "text" && typeof block.text === "string") return [block.text];
    if (typeof type !== "string" || type === "") return [];
    return [target ? `[${type}: ${target}]` : `[${type}]`];
  });
  return described.join("\n");
}

export function toolOutput(shape: ItemShape, tool?: string, content?: unknown) {
  const output = resultText(content);
  const command = tool === "Bash" || shape.type === "commandExecution";
  const silent = output.trim() === NO_OUTPUT || output === "";
  return command && silent ? undefined : output;
}

export function completedShape(
  shape: ItemShape,
  output: string | undefined,
  failed: boolean,
): ItemShape {
  const hidden = (line: string) =>
    line.startsWith("agentId:") || line.startsWith("<usage>");
  const lines = (output ?? "").split("\n").map((line) => line.trimEnd());
  const visible = lines.filter((line) => !hidden(line));
  switch (shape.type) {
    case "commandExecution":
      return { ...shape, exitCode: failed ? 1 : 0, aggregatedOutput: output };
    case "delegation":
      return { ...shape, summary: visible.join("\n").trim() || undefined };
    case "toolCall":
      return { ...shape, result: shape.result ?? output };
    case "webSearch":
    case "webFetch":
      return { ...shape, resultText: output ?? null };
    default:
      return shape;
  }
}

function planSnapshot(plan: TaskPlan): PlanStep[] {
  return [...plan.values()].flatMap((task) => {
    const active = task.status === "in_progress" && task.activeForm !== null;
    const step = active ? (task.activeForm ?? "") : task.subject;
    return step === "" ? [] : [{ step, status: PLAN_STATUS[task.status] }];
  });
}

export function decodeJson(value: unknown): unknown {
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return value;
  }
}

export function foldTaskResult(
  plan: TaskPlan,
  tool: string,
  input: unknown,
  rawOutput: unknown,
): PlanStep[] | null {
  const output = toRecord(decodeJson(rawOutput)) ?? {};
  const args = toRecord(input) ?? {};
  const before = JSON.stringify([...plan]);
  const id = text(args.taskId);
  const status = taskStatus.safeParse(args.status).data;
  const task = taskSchema.safeParse(output.task).data;
  const clean = (value: unknown) => text(value)?.trim() || null;
  const known = plan.get(id ?? "");
  const listed = z.array(z.unknown()).safeParse(output.tasks).data;
  if (tool === "TaskCreate" && task && typeof args.subject === "string") {
    const subject = clean(args.subject) ?? clean(task.subject) ?? "";
    const activeForm = clean(args.activeForm);
    plan.set(task.id, { subject, activeForm, status: "pending" });
    return planSnapshot(plan);
  }
  if (tool === "TaskList" && listed !== undefined) {
    plan.clear();
    for (const entry of listed) {
      const item = taskSchema.safeParse(entry).data;
      if (item?.status === undefined) continue;
      const subject = item.subject.trim();
      plan.set(item.id, { subject, activeForm: null, status: item.status });
    }
    return planSnapshot(plan);
  }
  const updated = output.success === true && typeof output.taskId === "string";
  const valid = args.status === undefined || status !== undefined;
  if (tool === "TaskUpdate" && id !== undefined && updated) {
    if (args.status === "deleted") plan.delete(id);
    else if (known !== undefined && valid) {
      const renamed = clean(args.activeForm);
      const activeForm =
        args.activeForm === undefined ? known.activeForm : renamed;
      const subject = clean(args.subject) ?? known.subject;
      plan.set(id, { subject, activeForm, status: status ?? known.status });
    }
  }
  return JSON.stringify([...plan]) === before ? null : planSnapshot(plan);
}
