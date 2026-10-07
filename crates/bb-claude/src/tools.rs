use std::collections::HashMap;
use std::sync::LazyLock;

use bb_provider::{
    Presentation, SearchMode, build_edit_diff, ellipsize, file_name, labels, presentation,
};
use indexmap::IndexMap;
use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value, json};

pub const BB_MCP_SERVER: &str = "bb-bridge";
pub const DETAIL_MAX_LENGTH: usize = 280;
const NO_OUTPUT: &str = "(Bash completed with no output)";
static MCP_TOOL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^mcp__(.+?)__(.+)$").expect("regex"));
const BUILTIN_TOOLS: &str = "
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
LS|Listing directory|Listed directory|FolderOpen||path";

/// A tool call mapped to its canonical item shape (`serde_json::Value`) and presentation.
#[derive(Clone, Debug)]
pub struct ClassifiedTool {
    pub shape: Value,
    pub presentation: Presentation,
    pub plan_steps: Option<Vec<PlanStep>>,
}

#[derive(Clone, Debug, Default)]
pub struct ToolContext {
    pub injected: HashMap<String, Option<Presentation>>,
    pub sandboxed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PlanStep {
    pub step: String,
    pub status: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlanTask {
    pub subject: String,
    pub active_form: Option<String>,
    pub status: String,
}

pub type TaskPlan = IndexMap<String, PlanTask>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BashCommand {
    pub command: String,
    pub cwd: Option<String>,
}

pub fn text(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

fn truthy(value: Option<&str>) -> Option<&str> {
    value.filter(|value| !value.is_empty())
}

fn plan_status(status: &str) -> Option<&'static str> {
    match status {
        "pending" => Some("pending"),
        "in_progress" => Some("active"),
        "completed" => Some("completed"),
        _ => None,
    }
}

fn task_status(value: Option<&Value>) -> Option<String> {
    text(value).filter(|s| plan_status(s).is_some()).map(str::to_owned)
}

fn made(shape: Value, presentation: Presentation) -> ClassifiedTool {
    ClassifiedTool { shape, presentation, plan_steps: None }
}

fn with_arguments(mut shape: Value, input: Option<&Value>) -> Value {
    if let (Some(args), Some(object)) = (input.filter(|v| v.is_object()), shape.as_object_mut()) {
        object.insert("arguments".to_owned(), args.clone());
    }
    shape
}

pub fn generic_tool(tool: &str, input: Option<&Value>) -> ClassifiedTool {
    let spec = BUILTIN_TOOLS
        .trim()
        .lines()
        .map(|row| row.split('|').collect::<Vec<_>>())
        .find(|row| row.first() == Some(&tool));
    let shape = with_arguments(json!({ "type": "toolCall", "tool": tool }), input);
    let Some(spec) = spec else { return made(shape, labels::tool(tool, None)) };
    let part = |index: usize| spec.get(index).copied().unwrap_or("");
    let title = truthy(Some(part(5))).and_then(|field| text(input.and_then(|i| i.get(field))));
    let mut known = presentation(part(1), part(2), part(3), title);
    if !part(4).is_empty() {
        known.suppress = Some(true);
    }
    made(shape, known)
}

fn file_change(tool: &str, args: &Value, input: Option<&Value>) -> ClassifiedTool {
    let notebook = tool == "NotebookEdit";
    let path = if notebook {
        text(args.get("notebook_path"))
    } else {
        text(args.get("file_path")).or(text(args.get("path")))
    };
    let (pending, completed) = match tool {
        "Write" => ("Writing file", "Wrote file"),
        "NotebookEdit" => ("Editing notebook", "Edited notebook"),
        _ => ("Editing file", "Edited file"),
    };
    let name = truthy(path).map(file_name);
    let presentation = presentation(pending, completed, "EditFile", name.as_deref());
    if notebook && path.is_none() {
        return generic_tool(tool, input);
    }
    if !notebook && truthy(path).is_none() {
        return ClassifiedTool { presentation, ..generic_tool(tool, input) };
    }
    let file = path.unwrap_or("");
    let change = |before: Option<&str>, after: Option<&str>| {
        let kind = if before.is_none() && !notebook { "add" } else { "update" };
        let mut change = json!({ "path": file, "kind": kind });
        if let Some(diff) = after.and_then(|after| build_edit_diff(file, before, Some(after))) {
            change["diff"] = Value::from(diff);
        }
        change
    };
    let edits = args.get("edits").and_then(Value::as_array).and_then(|edits| {
        edits
            .iter()
            .map(|edit| Some((text(edit.get("old_string"))?, text(edit.get("new_string"))?)))
            .collect::<Option<Vec<_>>>()
    });
    let changes: Vec<Value> = match edits {
        Some(edits) if tool == "MultiEdit" => {
            edits.into_iter().map(|(old, new)| change(Some(old), Some(new))).collect()
        }
        _ if notebook => vec![change(None, text(args.get("new_source")))],
        _ => {
            let written = text(args.get("new_string")).or(text(args.get("content")));
            vec![change(text(args.get("old_string")), written)]
        }
    };
    made(json!({ "type": "fileChange", "changes": changes }), presentation)
}

fn delegation(tool: &str, id: &str, args: &Value) -> ClassifiedTool {
    let (kind, model) = (text(args.get("subagent_type")), text(args.get("model")));
    let first_line = text(args.get("prompt")).map(|p| p.split('\n').next().unwrap_or("").trim());
    let label = text(args.get("description")).or(first_line).or(kind).unwrap_or(tool);
    let background = args.get("run_in_background") == Some(&Value::Bool(true));
    let (pending, completed) = if background {
        ("Launching subagent", "Launched subagent")
    } else {
        ("Running subagent", "Subagent finished")
    };
    let mut base = presentation(pending, completed, "UserRound", Some(label));
    let parts =
        [truthy(kind).map(|k| format!("{k} agent")), truthy(model).map(|m| format!("model {m}"))];
    let stated = parts.into_iter().flatten().collect::<Vec<_>>().join(" · ");
    let detail = ellipsize(&stated, DETAIL_MAX_LENGTH);
    if !detail.is_empty() {
        base.detail = Some(detail);
    }
    let shape =
        json!({ "type": "delegation", "childRef": id, "label": label, "background": background });
    made(shape, base)
}

pub fn parse_bash_command(input: &Value) -> Option<BashCommand> {
    let command = truthy(text(input.get("command")))?;
    let cwd = text(input.get("cwd")).map(str::to_owned);
    Some(BashCommand { command: command.to_owned(), cwd })
}

fn bash_command(args: &Value, sandboxed: bool) -> Option<ClassifiedTool> {
    let bash = parse_bash_command(args)?;
    let (pending, completed) = if args.get("run_in_background") == Some(&Value::Bool(true)) {
        ("Starting background command", "Started background command")
    } else {
        ("Running command", "Ran command")
    };
    let mut base = presentation(pending, completed, "Terminal", Some(&bash.command));
    if sandboxed && args.get("dangerouslyDisableSandbox") == Some(&Value::Bool(true)) {
        base.badge = Some(json!({
            "glyph": "SquareUnlock02",
            "label": "Outside of sandbox",
            "hint": "Outside of sandbox",
            "tone": "destructive",
        }));
    }
    let cwd = bash.cwd.unwrap_or_default();
    Some(made(json!({ "type": "commandExecution", "command": bash.command, "cwd": cwd }), base))
}

fn todo_plan_steps(todos: Option<&Value>) -> Option<Vec<PlanStep>> {
    let todos = todos?.as_array()?;
    let mut steps = Vec::new();
    for todo in todos {
        let (content, status) = (text(todo.get("content"))?, text(todo.get("status"))?);
        let Some(status) = plan_status(status) else { continue };
        let doing = if status == "active" { text(todo.get("activeForm")) } else { None };
        let step = doing.unwrap_or(content).trim();
        if !step.is_empty() {
            steps.push(PlanStep { step: step.to_owned(), status: status.to_owned() });
        }
    }
    Some(steps)
}

pub fn classify_tool(tool: &str, id: &str, input: &Value, context: &ToolContext) -> ClassifiedTool {
    let input_ref = Some(input).filter(|input| input.is_object());
    let empty = Value::Object(Map::new());
    let args = input_ref.unwrap_or(&empty);
    let path = text(args.get("file_path")).or(text(args.get("path")));
    let pattern = truthy(text(args.get("pattern")));
    let query = truthy(text(args.get("query")));
    let url = truthy(text(args.get("url")));
    if tool == "Bash"
        && let Some(bash) = bash_command(args, context.sandboxed)
    {
        return bash;
    }
    if let (true, Some(path)) = (tool == "Read", truthy(path)) {
        return made(json!({ "type": "fileRead", "path": path }), labels::file_read(path));
    }
    if let (true, Some(pattern)) = (tool == "Grep" || tool == "Glob", pattern) {
        let (mode, name) = if tool == "Grep" {
            (SearchMode::Content, "content")
        } else {
            (SearchMode::Path, "path")
        };
        let mut shape = json!({ "type": "search", "mode": name });
        if let Some(path) = truthy(path) {
            shape["path"] = Value::from(path);
        }
        shape["query"] = Value::from(pattern);
        return made(shape, labels::search(mode, pattern));
    }
    if matches!(tool, "Edit" | "MultiEdit" | "Write" | "NotebookEdit") {
        return file_change(tool, args, input_ref);
    }
    if let (true, Some(query)) = (tool == "WebSearch", query) {
        let shape = json!({ "type": "webSearch", "queries": [query], "resultText": null });
        return made(shape, labels::web_search(Some(query)));
    }
    if let (true, Some(url)) = (tool == "WebFetch", url) {
        let prompt = text(args.get("prompt"));
        let shape = json!({ "type": "webFetch", "url": url, "prompt": prompt, "pattern": null, "resultText": null });
        return made(shape, labels::web_fetch(url));
    }
    if tool == "Agent" || tool == "Task" {
        return delegation(tool, id, args);
    }
    if tool == "TodoWrite" {
        let plan_steps = todo_plan_steps(args.get("todos"));
        return ClassifiedTool { plan_steps, ..generic_tool(tool, input_ref) };
    }
    let Some(captures) = MCP_TOOL.captures(tool) else { return generic_tool(tool, input_ref) };
    let (server, mcp_tool) = (&captures[1], &captures[2]);
    let generic = labels::tool(mcp_tool, None);
    let from_bb = server == BB_MCP_SERVER;
    let shown = if from_bb {
        context.injected.get(mcp_tool).cloned().flatten().unwrap_or(generic)
    } else {
        Presentation { title: Some(server.to_owned()), ..generic }
    };
    let server = if from_bb { "bb" } else { server };
    let shape = json!({ "type": "toolCall", "tool": mcp_tool, "server": server });
    made(with_arguments(shape, input_ref), shown)
}

pub fn result_text(content: &Value) -> String {
    match content {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Array(items) => {
            let blocks: Vec<&Map<String, Value>> =
                items.iter().filter_map(Value::as_object).collect();
            let references: Vec<Option<&str>> = blocks
                .iter()
                .map(|b| {
                    (b.get("type") == Some(&json!("tool_reference")))
                        .then(|| truthy(text(b.get("tool_name"))))
                        .flatten()
                })
                .collect();
            if !references.is_empty() && references.iter().all(Option::is_some) {
                let names: Vec<&str> = references.into_iter().flatten().collect();
                return format!("Matched tools: {}", names.join(", "));
            }
            let described: Vec<String> = blocks
                .iter()
                .filter_map(|block| {
                    let kind = text(block.get("type"));
                    if let (Some("text"), Some(said)) = (kind, text(block.get("text"))) {
                        return Some(said.to_owned());
                    }
                    let kind = truthy(kind)?;
                    let target = ["path", "tool_name", "url", "imageUrl"]
                        .iter()
                        .find_map(|key| truthy(text(block.get(*key))));
                    Some(match target {
                        Some(target) => format!("[{kind}: {target}]"),
                        None => format!("[{kind}]"),
                    })
                })
                .collect();
            described.join("\n")
        }
        other => match other.get("content") {
            Some(nested @ Value::Array(_)) => result_text(nested),
            _ => other.to_string(),
        },
    }
}

pub fn tool_output(shape: &Value, tool: Option<&str>, content: &Value) -> Option<String> {
    let output = result_text(content);
    let command = tool == Some("Bash") || shape_type(shape) == "commandExecution";
    let silent = output.trim() == NO_OUTPUT || output.is_empty();
    (!(command && silent)).then_some(output)
}

pub fn shape_type(shape: &Value) -> &str {
    text(shape.get("type")).unwrap_or("")
}

pub fn completed_shape(shape: &Value, output: Option<&str>, failed: bool) -> Value {
    let mut next = shape.clone();
    let Some(object) = next.as_object_mut() else { return next };
    let mut set = |key: &str, value: Option<Value>| match value {
        Some(value) => {
            object.insert(key.to_owned(), value);
        }
        None => {
            object.shift_remove(key);
        }
    };
    match shape_type(shape) {
        "commandExecution" => {
            set("exitCode", Some(Value::from(if failed { 1 } else { 0 })));
            set("aggregatedOutput", output.map(Value::from));
        }
        "delegation" => {
            let visible: Vec<&str> = output
                .unwrap_or("")
                .split('\n')
                .map(str::trim_end)
                .filter(|line| !line.starts_with("agentId:") && !line.starts_with("<usage>"))
                .collect();
            let summary = visible.join("\n").trim().to_owned();
            set("summary", (!summary.is_empty()).then(|| Value::from(summary)));
        }
        "toolCall" => {
            let result = shape.get("result").filter(|r| !r.is_null()).cloned();
            set("result", result.or(output.map(Value::from)));
        }
        "webSearch" | "webFetch" => {
            set("resultText", Some(output.map_or(Value::Null, Value::from)))
        }
        _ => {}
    }
    next
}

fn plan_snapshot(plan: &TaskPlan) -> Vec<PlanStep> {
    plan.values()
        .filter_map(|task| {
            let active = task.status == "in_progress" && task.active_form.is_some();
            let step = if active {
                task.active_form.clone().unwrap_or_default()
            } else {
                task.subject.clone()
            };
            let status = plan_status(&task.status)?.to_owned();
            (!step.is_empty()).then_some(PlanStep { step, status })
        })
        .collect()
}

pub fn decode_json(value: &Value) -> Value {
    match value {
        Value::String(raw) => serde_json::from_str(raw).unwrap_or_else(|_| value.clone()),
        other => other.clone(),
    }
}

fn parse_task(value: Option<&Value>) -> Option<(String, String, Option<String>)> {
    let value = value?;
    let (id, subject) = (text(value.get("id"))?, text(value.get("subject"))?);
    Some((id.to_owned(), subject.to_owned(), task_status(value.get("status"))))
}

fn clean(value: Option<&Value>) -> Option<String> {
    truthy(text(value).map(str::trim)).map(str::to_owned)
}

pub fn fold_task_result(
    plan: &mut TaskPlan,
    tool: &str,
    input: Option<&Value>,
    raw_output: Option<&Value>,
) -> Option<Vec<PlanStep>> {
    let decoded = raw_output.map(decode_json).filter(Value::is_object).unwrap_or(json!({}));
    let output = &decoded;
    let args = input.filter(|v| v.is_object()).cloned().unwrap_or(json!({}));
    let before: Vec<(String, PlanTask)> = plan.clone().into_iter().collect();
    let id = text(args.get("taskId"));
    let status = task_status(args.get("status"));
    let task = parse_task(output.get("task"));
    let known = plan.get(id.unwrap_or("")).cloned();
    if let (true, Some(task), Some(_)) = (tool == "TaskCreate", &task, text(args.get("subject"))) {
        let subject = clean(args.get("subject"))
            .or(clean(Some(&Value::from(task.1.clone()))))
            .unwrap_or_default();
        let active_form = clean(args.get("activeForm"));
        plan.insert(
            task.0.clone(),
            PlanTask { subject, active_form, status: "pending".to_owned() },
        );
        return Some(plan_snapshot(plan));
    }
    if let (true, Some(listed)) =
        (tool == "TaskList", output.get("tasks").and_then(Value::as_array))
    {
        plan.clear();
        for entry in listed {
            let Some((id, subject, Some(status))) = parse_task(Some(entry)) else { continue };
            plan.insert(
                id,
                PlanTask { subject: subject.trim().to_owned(), active_form: None, status },
            );
        }
        return Some(plan_snapshot(plan));
    }
    let updated =
        output.get("success") == Some(&Value::Bool(true)) && text(output.get("taskId")).is_some();
    let valid = args.get("status").is_none() || status.is_some();
    if let (true, Some(id), true) = (tool == "TaskUpdate", id, updated) {
        if text(args.get("status")) == Some("deleted") {
            plan.shift_remove(id);
        } else if let (Some(known), true) = (known, valid) {
            let active_form = if args.get("activeForm").is_none() {
                known.active_form
            } else {
                clean(args.get("activeForm"))
            };
            let subject = clean(args.get("subject")).unwrap_or(known.subject);
            let status = status.unwrap_or(known.status);
            plan.insert(id.to_owned(), PlanTask { subject, active_form, status });
        }
    }
    let after: Vec<(String, PlanTask)> = plan.clone().into_iter().collect();
    (after != before).then(|| plan_snapshot(plan))
}
