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

export interface ToolResult {
  toolName: string | undefined;
  content: unknown;
  processResult: unknown;
}

interface PlanTask {
  subject: string;
  activeForm: string | null;
  status: "pending" | "in_progress" | "completed";
}
export type TaskPlan = Map<string, PlanTask>;

export const BB_MCP_SERVER = "bb-bridge";
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
TodoRead|Reading todos|Read todos|ListTodo|hide
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
BashOutput|Reading shell output|Read shell output|Terminal|hide
EnterPlanMode|Entering plan mode|Entered plan mode|ListTodo
ExitPlanMode|Presenting plan|Presented plan|FileText
Workflow|Starting workflow|Started workflow|Workflow
TaskStop|Stopping task|Stopped task|Terminal
ListAgents|Listing agents|Listed agents|UserRound
Skill|Loading skill|Loaded skill|Zap||skill
StructuredOutput|Returning structured output|Returned structured output|Code
EnterWorktree|Entering worktree|Entered worktree|GitBranch
ExitWorktree|Leaving worktree|Left worktree|GitBranch
LS|Listing directory|Listed directory|FolderOpen||path
KillShell|Stopping shell|Stopped shell|Terminal`;
const builtinTools = new Map(
  BUILTIN_TOOLS.trim()
    .split("\n")
    .map((row) => {
      const [tool = "", ...spec] = row.split("|");
      return [tool, spec] as const;
    }),
);
const FILE_VERBS = {
  edit: ["Editing file", "Edited file"],
  write: ["Writing file", "Wrote file"],
  notebook: ["Editing notebook", "Edited notebook"],
} as const;
const PLAN_STATUS: Record<string, PlanStep["status"]> = {
  pending: "pending",
  in_progress: "active",
  completed: "completed",
};
const EDIT_TOOLS: Record<string, keyof typeof FILE_VERBS | undefined> = {
  Edit: "edit",
  MultiEdit: "edit",
  Write: "write",
  NotebookEdit: "notebook",
};

const record = z.record(z.string(), z.unknown());
const optionalText = z.string().optional();
const fileEditSchema = z.object({
  file_path: optionalText,
  path: optionalText,
  old_string: optionalText,
  new_string: optionalText,
  content: optionalText,
});
const multiEditSchema = z.object({
  file_path: z.string(),
  edits: z.array(z.object({ old_string: z.string(), new_string: z.string() })),
});
const notebookSchema = z.object({
  notebook_path: z.string(),
  new_source: optionalText,
});
const agentSchema = z.object({
  description: optionalText,
  prompt: optionalText,
  subagent_type: optionalText,
  model: optionalText,
  run_in_background: z.boolean().optional(),
});
const todoSchema = z.object({
  todos: z.array(
    z.object({
      content: z.string(),
      status: z.string(),
      activeForm: optionalText,
    }),
  ),
});
const processResultSchema = z.union([
  z.string(),
  z.looseObject({ stdout: optionalText, stderr: optionalText }),
]);
const taskStatus = z.enum(["pending", "in_progress", "completed"]);
const taskEntry = z.object({ id: z.string(), subject: z.string() });
const taskCreate = z.object({
  input: z.object({ subject: z.string(), activeForm: optionalText }),
  output: z.object({ task: taskEntry }),
});
const taskUpdate = z.object({
  input: z.object({
    taskId: z.string(),
    status: z.enum([...taskStatus.options, "deleted"]).optional(),
    subject: optionalText,
    activeForm: optionalText,
  }),
  output: z.object({ success: z.literal(true), taskId: z.string() }),
});
const taskList = z.object({
  output: z.object({ tasks: z.array(z.unknown()) }),
});
const listedTask = taskEntry.extend({ status: taskStatus });
const taskGet = z.object({
  input: z.object({ taskId: z.string() }),
  output: z.object({ task: listedTask.nullable() }),
});

function text(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function toRecord(value: unknown) {
  return record.safeParse(value).data;
}

function builtinPresentation(tool: string, input: unknown): Presentation {
  const spec = builtinTools.get(tool);
  if (spec === undefined) return ui.labels.tool(tool);
  const [pending = tool, completed = tool, glyph = "Toolbox", hide, field] =
    spec;
  const title = field ? text(toRecord(input)?.[field]) : undefined;
  const base = ui.presentation(pending, completed, glyph, title);
  return hide ? { ...base, suppress: true } : base;
}

function genericTool(tool: string, input: unknown): ClassifiedTool {
  const shape = { type: "toolCall" as const, tool };
  return {
    shape: { ...shape, arguments: toRecord(input) },
    presentation: builtinPresentation(tool, input),
  };
}

function fileChangePresentation(
  verb: keyof typeof FILE_VERBS,
  path: string | null,
) {
  const [pending, completed] = FILE_VERBS[verb];
  const title = path === null ? undefined : ui.fileName(path);
  return ui.presentation(pending, completed, "EditFile", title);
}

function fileChange(
  tool: string,
  verb: keyof typeof FILE_VERBS,
  input: unknown,
): ClassifiedTool {
  const parsed = fileEditSchema.safeParse(input);
  if (!parsed.success) return genericTool(tool, input);
  const edit = parsed.data;
  const path = edit.file_path ?? edit.path;
  if (!path) {
    const presentation = fileChangePresentation(verb, null);
    return { ...genericTool(tool, input), presentation };
  }
  const newText = edit.new_string ?? edit.content;
  const kind = edit.old_string === undefined ? "add" : "update";
  const diff =
    newText === undefined
      ? undefined
      : ui.buildEditDiff(path, edit.old_string, newText);
  return {
    shape: { type: "fileChange", changes: [{ path, kind, diff }] },
    presentation: fileChangePresentation(verb, path),
  };
}

function multiEdit(tool: string, input: unknown): ClassifiedTool {
  const parsed = multiEditSchema.safeParse(input);
  if (!parsed.success) return fileChange(tool, "edit", input);
  const path = parsed.data.file_path;
  const changes = parsed.data.edits.map((edit) => ({
    path,
    kind: "update" as const,
    diff: ui.buildEditDiff(path, edit.old_string, edit.new_string),
  }));
  return {
    shape: { type: "fileChange", changes },
    presentation: fileChangePresentation("edit", path),
  };
}

function notebookEdit(tool: string, input: unknown): ClassifiedTool {
  const parsed = notebookSchema.safeParse(input);
  if (!parsed.success) return genericTool(tool, input);
  const { notebook_path: path, new_source: source } = parsed.data;
  const diff =
    source === undefined
      ? undefined
      : ui.buildEditDiff(path, undefined, source);
  return {
    shape: { type: "fileChange", changes: [{ path, kind: "update", diff }] },
    presentation: fileChangePresentation("notebook", path),
  };
}

function delegation(tool: string, id: string, input: unknown): ClassifiedTool {
  const parsed = agentSchema.safeParse(input);
  if (!parsed.success) return genericTool(tool, input);
  const agent = parsed.data;
  const firstLine = agent.prompt?.split("\n", 1)[0]?.trim();
  const label = agent.description ?? firstLine ?? agent.subagent_type ?? tool;
  const background = agent.run_in_background === true;
  const [pending, completed] = background
    ? ["Launching subagent", "Launched subagent"]
    : ["Running subagent", "Subagent finished"];
  const base = ui.presentation(pending, completed, "UserRound", label);
  const detail = [
    agent.subagent_type === undefined ? [] : [`${agent.subagent_type} agent`],
    agent.model === undefined ? [] : [`model ${agent.model}`],
  ]
    .flat()
    .join(" · ");
  return {
    shape: { type: "delegation", childRef: id, label, background },
    presentation: detail
      ? { ...base, detail: ui.ellipsize(detail, DETAIL_MAX_LENGTH) }
      : base,
  };
}

export function parseBashCommand(input: unknown) {
  const args = toRecord(input);
  const command = text(args?.command);
  return command ? { command, cwd: text(args?.cwd) ?? null } : undefined;
}

function bashCommand(
  args: Record<string, unknown>,
  sandboxed: boolean,
): ClassifiedTool | undefined {
  const bash = parseBashCommand(args);
  if (bash === undefined) return undefined;
  const [pending, completed] =
    args.run_in_background === true
      ? ["Starting background command", "Started background command"]
      : ["Running command", "Ran command"];
  const base = ui.presentation(pending, completed, "Terminal", bash.command);
  const escaped = sandboxed && args.dangerouslyDisableSandbox === true;
  const shape = { type: "commandExecution" as const, command: bash.command };
  return {
    shape: { ...shape, cwd: bash.cwd ?? "" },
    presentation: escaped ? { ...base, badge: SANDBOX_BADGE } : base,
  };
}

function todoPlanSteps(input: unknown): PlanStep[] | undefined {
  const parsed = todoSchema.safeParse(input);
  if (!parsed.success) return undefined;
  return parsed.data.todos.flatMap((todo) => {
    const status = PLAN_STATUS[todo.status];
    const active = status === "active" && todo.activeForm !== undefined;
    const step = (active ? (todo.activeForm ?? "") : todo.content).trim();
    return status === undefined || step === "" ? [] : [{ step, status }];
  });
}

export function classifyTool(
  tool: string,
  id: string,
  input: unknown,
  context: ToolContext,
): ClassifiedTool {
  const fields = toRecord(input);
  const args = fields ?? {};
  const path = text(args.file_path) ?? text(args.path);
  const pattern = text(args.pattern);
  const query = text(args.query);
  const url = text(args.url);
  switch (tool) {
    case "Bash": {
      const bash = bashCommand(args, context.sandboxed);
      if (bash === undefined) break;
      return bash;
    }
    case "Read":
      if (!path) break;
      return {
        shape: { type: "fileRead", path },
        presentation: ui.labels.fileRead(path),
      };
    case "Grep":
    case "Glob": {
      if (!pattern) break;
      const mode = tool === "Grep" ? "content" : "path";
      const scope = text(args.path) || undefined;
      return {
        shape: { type: "search", mode, query: pattern, path: scope },
        presentation: ui.labels.search(mode, pattern),
      };
    }
    case "Edit":
      return fileChange(tool, "edit", input);
    case "Write":
      return fileChange(tool, "write", input);
    case "MultiEdit":
      return multiEdit(tool, input);
    case "NotebookEdit":
      return notebookEdit(tool, input);
    case "WebSearch":
      if (!query) break;
      return {
        shape: { type: "webSearch", queries: [query], resultText: null },
        presentation: ui.labels.webSearch(query),
      };
    case "WebFetch": {
      if (!url) break;
      const prompt = text(args.prompt) ?? null;
      const fetch = { url, prompt, pattern: null, resultText: null };
      return {
        shape: { type: "webFetch", ...fetch },
        presentation: ui.labels.webFetch(url),
      };
    }
    case "Agent":
    case "Task":
      return delegation(tool, id, input);
    case "TodoWrite":
      return { ...genericTool(tool, input), planSteps: todoPlanSteps(input) };
  }
  const [, server, mcpTool] = MCP_TOOL.exec(tool) ?? [];
  if (!server || !mcpTool) return genericTool(tool, input);
  const fromBb = server === BB_MCP_SERVER;
  const shape = { type: "toolCall" as const, tool: mcpTool };
  return {
    shape: { ...shape, server: fromBb ? "bb" : server, arguments: fields },
    presentation: fromBb
      ? (context.injected.get(mcpTool) ?? ui.labels.tool(mcpTool))
      : { ...ui.labels.tool(mcpTool), title: server },
  };
}

export function classifyUnseenTool(
  tool: string | undefined,
  cwd: string,
): ClassifiedTool {
  if (tool === "Bash" && cwd !== "") {
    return {
      shape: { type: "commandExecution", command: "", cwd },
      presentation: ui.presentation(
        "Running command",
        "Ran command",
        "Terminal",
      ),
    };
  }
  if (tool === "Bash") return genericTool(tool, {});
  const verb = EDIT_TOOLS[tool ?? ""];
  if (verb === undefined) return genericTool(tool ?? "unknown", undefined);
  return {
    shape: { type: "fileChange", changes: [] },
    presentation: fileChangePresentation(verb, null),
  };
}

function describeBlock(block: unknown) {
  const fields = toRecord(block);
  const type = text(fields?.type);
  if (fields === undefined || !type) return [];
  if (type === "text" && typeof fields.text === "string") return [fields.text];
  const target =
    text(fields.path) ||
    text(fields.tool_name) ||
    text(fields.url) ||
    text(fields.imageUrl);
  return [target ? `[${type}: ${target}]` : `[${type}]`];
}

export function resultText(content: unknown): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    const nested = toRecord(content)?.content;
    return Array.isArray(nested) ? resultText(nested) : JSON.stringify(content);
  }
  const blocks = content.map((block) => toRecord(block));
  const references = blocks.map((block) =>
    block?.type === "tool_reference" ? text(block.tool_name) : undefined,
  );
  if (references.length > 0 && references.every(Boolean)) {
    return `Matched tools: ${references.join(", ")}`;
  }
  return content.flatMap(describeBlock).join("\n");
}

function meaningful(output: string) {
  return output.trim() === NO_OUTPUT || output === "" ? undefined : output;
}

function commandOutput(result: ToolResult) {
  const fromContent = meaningful(resultText(result.content));
  const streams = processResultSchema.safeParse(result.processResult).data;
  if (streams === undefined) return fromContent;
  if (typeof streams === "string") return meaningful(streams) ?? fromContent;
  const { stdout = "", stderr = "" } = streams;
  const separator = stdout === "" || stdout.endsWith("\n") ? "" : "\n";
  const joined = stderr === "" ? stdout : `${stdout}${separator}${stderr}`;
  return joined === "" ? fromContent : joined;
}

export function toolOutput(shape: ItemShape, result: ToolResult) {
  const isCommand =
    result.toolName === "Bash" || shape.type === "commandExecution";
  return isCommand ? commandOutput(result) : resultText(result.content);
}

function agentSummary(output: string) {
  const hidden = (line: string) =>
    line.startsWith("agentId:") || line.startsWith("<usage>");
  const lines = output.split("\n").map((line) => line.trimEnd());
  return lines
    .filter((line) => !hidden(line))
    .join("\n")
    .trim();
}

export function completedShape(
  shape: ItemShape,
  output: string | undefined,
  failed: boolean,
): ItemShape {
  switch (shape.type) {
    case "commandExecution":
      return { ...shape, exitCode: failed ? 1 : 0, aggregatedOutput: output };
    case "delegation":
      return { ...shape, summary: agentSummary(output ?? "") || undefined };
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

function parseJson(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
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
  const call = { input, output: parseJson(rawOutput) };
  const trimmed = (value: string | undefined) => value?.trim() || null;
  const replace = (id: string, next: PlanTask) => {
    const known = plan.get(id);
    const same =
      known !== undefined &&
      known.subject === next.subject &&
      known.activeForm === next.activeForm &&
      known.status === next.status;
    if (same) return null;
    plan.set(id, next);
    return planSnapshot(plan);
  };
  const remove = (id: string) => (plan.delete(id) ? planSnapshot(plan) : null);
  if (tool === "TaskCreate") {
    const { data } = taskCreate.safeParse(call);
    if (data === undefined) return null;
    const { task } = data.output;
    const subject = trimmed(data.input.subject) ?? trimmed(task.subject) ?? "";
    const activeForm = trimmed(data.input.activeForm);
    plan.set(task.id, { subject, activeForm, status: "pending" });
    return planSnapshot(plan);
  }
  if (tool === "TaskUpdate") {
    const { data } = taskUpdate.safeParse(call);
    if (data === undefined) return null;
    const { taskId, status, subject, activeForm } = data.input;
    if (status === "deleted") return remove(taskId);
    const known = plan.get(taskId);
    if (known === undefined) return null;
    return replace(taskId, {
      subject: trimmed(subject) ?? known.subject,
      activeForm:
        activeForm === undefined ? known.activeForm : trimmed(activeForm),
      status: status ?? known.status,
    });
  }
  if (tool === "TaskList") {
    const { data } = taskList.safeParse(call);
    if (data === undefined) return null;
    plan.clear();
    for (const raw of data.output.tasks) {
      const task = listedTask.safeParse(raw).data;
      if (task === undefined) continue;
      const subject = task.subject.trim();
      plan.set(task.id, { subject, activeForm: null, status: task.status });
    }
    return planSnapshot(plan);
  }
  if (tool !== "TaskGet") return null;
  const { data } = taskGet.safeParse(call);
  if (data === undefined) return null;
  const { task } = data.output;
  if (task === null) return remove(data.input.taskId);
  return replace(task.id, {
    subject: task.subject.trim(),
    activeForm: plan.get(task.id)?.activeForm ?? null,
    status: task.status,
  });
}
