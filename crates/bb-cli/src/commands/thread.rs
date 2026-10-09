use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};

use crate::call::{
    Call, CliError, CliResult, Handler, Output, confirm, duration_ms, integer, locale_date,
    machine_flag, machine_or_this, now_ms, send_at_ms, text_input, thread_target, usage_error,
    valid_id,
};
use crate::commands::workspace::{pull_request_op, read_client_file, upload_attachment};
use crate::http::encode;
use crate::render::{pending_todos_of, queue_wait, shown, text, thread_lines, todo_lines};

const WORKSPACE_KINDS: &[&str] = &["worktree", "checkout", "personal"];
const OPEN_SPLITS: &[&str] = &["right", "down", "left", "top", "replace"];
const REASONING_LEVELS: &[&str] =
    &["none", "low", "medium", "high", "xhigh", "ultracode", "max", "ultra"];
const PERMISSION_MODES: &[&str] = &["accept-edits", "auto", "full"];
const VISIBILITIES: &[&str] = &["visible", "hidden"];
const THREAD_STATUSES: &[&str] = &["pending", "idle", "starting", "active", "stopping", "error"];
const EVENT_PAGE_SIZE: usize = 100;
const PERSONAL_PROJECT_ID: &str = "proj_personal";
const MAX_EVENT_WAIT_MS: u64 = 30_000;

/// Handlers ported from `apps/cli/src/commands/thread.ts`.
pub fn handlers() -> Vec<(&'static str, Handler)> {
    vec![
        ("threadSpawn", thread_spawn),
        ("threadTell", thread_tell),
        ("threadWait", thread_wait),
        ("threadShow", thread_show),
        ("threadLog", thread_log),
        ("threadOutput", thread_output),
        ("threadList", thread_list),
        ("threadUpdate", thread_update),
        ("threadDelete", thread_delete),
        ("threadSearch", thread_search),
        ("threadOpen", thread_open),
        ("threadStop", thread_stop),
        ("threadArchive", thread_archive),
        ("threadUnarchive", thread_unarchive),
        ("threadCompact", thread_compact),
        ("threadClear", thread_clear),
        ("threadRetry", thread_retry),
        ("threadPin", thread_pin),
        ("threadUnpin", thread_unpin),
        ("threadRead", thread_read),
        ("threadUnread", thread_unread),
    ]
}

fn at(thread_id: &str, tail: &str) -> String {
    format!("/threads/{}{tail}", encode(thread_id))
}

fn put(body: &mut Map<String, Value>, key: &str, value: Option<impl Into<Value>>) {
    if let Some(value) = value {
        body.insert(key.into(), value.into());
    }
}

fn execution(call: &Call, body: &mut Map<String, Value>) -> CliResult<()> {
    put(body, "model", call.flag("model")?);
    put(body, "reasoningLevel", call.choice("reasoning-level", REASONING_LEVELS)?);
    put(body, "permissionMode", call.choice("permission-mode", PERMISSION_MODES)?);
    Ok(())
}

fn send_at(call: &Call) -> CliResult<Option<i64>> {
    let at = send_at_ms(call.flag("send-at")?.as_deref(), now_ms())?;
    Ok(at.map(|at| at.round() as i64))
}

fn client_path(value: &str) -> CliResult<Option<String>> {
    if Path::new(value).is_absolute() {
        return Ok(Some(value.to_string()));
    }
    if !value.to_lowercase().starts_with("file:") {
        return Ok(None);
    }
    file_url_path(&value[5..]).map(Some)
}

fn file_url_path(rest: &str) -> CliResult<String> {
    let rest = rest.split(['?', '#']).next().unwrap_or_default();
    let path = match rest.strip_prefix("//") {
        Some(authority) => {
            let (host, path) =
                authority.find('/').map_or((authority, "/"), |at| authority.split_at(at));
            if !host.is_empty() && !host.eq_ignore_ascii_case("localhost") {
                let message = "File URL host must be \"localhost\" or empty on linux";
                return Err(CliError::new(message).code("ERR_INVALID_FILE_URL_HOST"));
            }
            path.to_string()
        }
        None if rest.starts_with('/') => rest.to_string(),
        None => format!("/{rest}"),
    };
    if path.to_lowercase().contains("%2f") {
        let message = "File URL path must not include encoded / characters";
        return Err(CliError::new(message).code("ERR_INVALID_FILE_URL_PATH"));
    }
    Ok(percent_decode(&path))
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let hex = bytes.get(at + 1..at + 3).and_then(|pair| std::str::from_utf8(pair).ok());
        match hex.and_then(|pair| u8::from_str_radix(pair, 16).ok()) {
            Some(byte) if bytes[at] == b'%' => {
                out.push(byte);
                at += 3;
            }
            _ => {
                out.push(bytes[at]);
                at += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn prompt_input(
    call: &Call,
    text: &str,
    project_id: &dyn Fn(&Call) -> CliResult<String>,
) -> CliResult<Value> {
    let mut input = vec![json!({ "type": "text", "text": text, "mentions": [] })];
    for (flag, kind) in [("file", "localFile"), ("image", "localImage")] {
        for value in call.list(flag)? {
            let Some(local) = client_path(&value)? else {
                input.push(json!({ "type": kind, "path": value }));
                continue;
            };
            let project_id = project_id(call)?;
            let bytes = read_client_file(&local)?;
            let filename = Path::new(&local)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            let uploaded = upload_attachment(call, &project_id, &filename, bytes)?;
            input.push(json!({ "type": kind, "path": uploaded["path"] }));
        }
    }
    Ok(Value::Array(input))
}

fn spawn_environment(call: &Call, project_id: &str) -> CliResult<Value> {
    let value = call.flag("environment")?.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    let kind = call.choice("new-environment", WORKSPACE_KINDS)?;
    let base = call.flag("base-branch")?.map(|b| b.trim().to_string()).unwrap_or_default();
    if value.is_some() && kind.is_some() {
        return Err(usage_error("Cannot combine --environment with --new-environment."));
    }
    if !base.is_empty() && kind != Some("worktree") {
        return Err(usage_error("--base-branch requires --new-environment worktree."));
    }
    if let Some(value) = &value {
        let is_path = value.starts_with(['.', '~']) || value.contains('/');
        if !is_path {
            if !call.on("machine")? {
                let id = valid_id(value, "--environment")?;
                return Ok(json!({ "type": "reuse", "environmentId": id }));
            }
            return Err(usage_error(
                "Cannot combine --machine with an environment ID; that environment already \
                 selects its machine.",
            ));
        }
    }
    if value.is_none() && kind.is_none() && !call.on("machine")? {
        return Ok(json!({ "type": "project-default" }));
    }
    let host_id = machine_or_this(call)?;
    if kind == Some("worktree") {
        let base_branch = if base.is_empty() {
            json!({ "kind": "default" })
        } else {
            json!({ "kind": "named", "name": base })
        };
        let workspace = json!({ "type": "managed-worktree", "baseBranch": base_branch });
        return Ok(json!({ "type": "host", "hostId": host_id, "workspace": workspace }));
    }
    let personal = value.is_none() && kind.is_none() && project_id == PERSONAL_PROJECT_ID;
    if kind == Some("personal") || personal {
        let workspace = json!({ "type": "personal" });
        return Ok(json!({ "type": "host", "hostId": host_id, "workspace": workspace }));
    }
    let workspace = json!({ "type": "unmanaged", "path": value });
    Ok(json!({ "type": "host", "hostId": host_id, "workspace": workspace }))
}

fn spawn_parent(call: &Call) -> CliResult<Option<String>> {
    let explicit = call.id("parent-thread")?;
    if !call.on("parent-self")? {
        return Ok(explicit);
    }
    if explicit.is_some() {
        return Err(usage_error("Cannot combine --parent-thread with --parent-self."));
    }
    match &call.env.thread_id {
        Some(current) => Ok(Some(current.clone())),
        None => Err(usage_error("--parent-self requires BB_THREAD_ID to be set.")),
    }
}

fn thread_spawn(call: &mut Call) -> CliResult<Output> {
    let prompt = call.flag("prompt")?;
    let text = text_input(call, prompt.as_deref(), "prompt-file", "--prompt <text>")?;
    let Some(project_id) = call.id("project")? else {
        let current = call.env.project_id.clone();
        let current = current.unwrap_or_else(|| "<id> (see `bb project list`)".into());
        return Err(CliError::new("Missing required option --project <id>.")
            .code("missing_required")
            .hint(format!("Add --project {current}.")));
    };
    let parent_thread_id = spawn_parent(call)?;
    let scheduled = send_at(call)?;
    let mut body = Map::new();
    body.insert("projectId".into(), json!(project_id));
    body.insert("environment".into(), spawn_environment(call, &project_id)?);
    let known = project_id.clone();
    let input = prompt_input(call, &text, &move |_: &Call| Ok(known.clone()))?;
    let provider = call.flag("provider")?.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    put(&mut body, "providerId", provider);
    execution(call, &mut body)?;
    put(&mut body, "title", call.flag("title")?.filter(|t| !t.is_empty()));
    put(&mut body, "visibility", call.choice("visibility", VISIBILITIES)?);
    put(&mut body, "parentThreadId", parent_thread_id.clone());
    put(&mut body, "sectionId", call.id("section")?);
    body.insert("input".into(), input);
    body.insert("origin".into(), json!("cli"));
    body.insert("startedOnBehalfOf".into(), Value::Null);
    put(&mut body, "sendAt", scheduled);
    let thread = call.http.post("/threads", &Value::Object(body))?;
    let mut lines = vec![format!("Thread spawned: {}", text_of(&thread, "id"))];
    if let Some(scheduled) = scheduled {
        let when = locale_date(scheduled as f64);
        lines.push(format!("First message scheduled for {when}; pending until then."));
    }
    if parent_thread_id.is_some() && parent_thread_id == call.env.thread_id {
        lines.push("You will be notified when this thread is done.".into());
    }
    lines.push(String::new());
    lines.extend(thread_lines(&thread, &Value::Null));
    lines.push(String::new());
    Ok(Output::lines(thread, &lines))
}

fn text_of(value: &Value, key: &str) -> String {
    value.get(key).map(shown).unwrap_or_else(|| "undefined".into())
}

fn thread_tell(call: &mut Call) -> CliResult<Output> {
    let thread_id = valid_id(call.arg("id")?, "<id> argument")?;
    let message = call.args("message").map(String::from);
    let message = text_input(call, message.as_deref(), "message-file", "<message>")?;
    let mode = call.choice("mode", &["steer", "queue", "auto"])?.unwrap_or("steer");
    let mut body = Map::new();
    let project = |call: &Call| -> CliResult<String> {
        let thread = call.http.get(&at(&thread_id, ""), &[])?;
        Ok(text(&thread, "projectId").unwrap_or("undefined").to_string())
    };
    body.insert("input".into(), prompt_input(call, &message, &project)?);
    let wire = if mode == "auto" { mode.to_string() } else { format!("{mode}-if-active") };
    body.insert("mode".into(), json!(wire));
    execution(call, &mut body)?;
    let sender = call.env.thread_id.clone().filter(|sender| *sender != thread_id);
    put(&mut body, "senderThreadId", sender);
    put(&mut body, "sendAt", send_at(call)?);
    let response = call.http.post(&at(&thread_id, "/send"), &Value::Object(body))?;
    let outcome = if text(&response, "delivery") == Some("queued") {
        let queued = response.get("queuedMessage").cloned().unwrap_or(Value::Null);
        format!("message queued ({}); it dispatches when that clears", queue_wait(&queued))
    } else if mode == "steer" {
        "steered".into()
    } else {
        "updated".into()
    };
    let mut data = Map::new();
    data.insert("threadId".into(), json!(thread_id));
    if let Value::Object(fields) = response {
        data.extend(fields);
    }
    data.insert("mode".into(), json!(mode));
    Ok(Output::text(Value::Object(data), format!("Thread {thread_id} {outcome}")))
}

struct WaitRequest {
    thread_id: String,
    target: Value,
    timeout_ms: u64,
    poll_interval_ms: u64,
}

fn wait_request(call: &Call) -> CliResult<WaitRequest> {
    let event = call.flag("event")?;
    if event.is_some() && call.on("status")? {
        return Err(usage_error("Provide only one of --status or --event."));
    }
    let status = call.choice("status", THREAD_STATUSES)?.unwrap_or("idle");
    let interval = call.flag("poll-interval")?.unwrap_or_else(|| "250ms".into());
    let thread_id = valid_id(call.arg("id")?, "<id> argument")?;
    let target = match event {
        None => json!({ "kind": "status", "status": status }),
        Some(event) => json!({ "kind": "event", "eventType": event }),
    };
    let timeout = call.flag("timeout")?.unwrap_or_else(|| "1200".into());
    let timeout_ms = duration_ms(&timeout, "--timeout", "s", true)?;
    let poll_interval_ms = duration_ms(&interval, "--poll-interval", "ms", false)?;
    Ok(WaitRequest { thread_id, target, timeout_ms, poll_interval_ms })
}

fn wait_failure(message: String, code: &str, exit_code: i32) -> CliError {
    CliError::new(message).code(code).exit_code(exit_code)
}

fn thread_wait(call: &mut Call) -> CliResult<Output> {
    let request = wait_request(call).map_err(|e| {
        let code = e.code.clone();
        wait_failure(e.message, &code, 3)
    })?;
    let WaitRequest { thread_id, target, .. } = &request;
    let deadline = Instant::now() + Duration::from_millis(request.timeout_ms);
    let status = text(target, "status").map(String::from);
    let event_type = text(target, "eventType").unwrap_or("").to_string();
    let reached = loop {
        if let Some(status) = &status {
            let thread = call.http.get(&at(thread_id, ""), &[])?;
            let current = text(&thread, "status").unwrap_or("");
            if current == status {
                break format!("reached status {status}");
            }
            if status == "idle" && current == "error" {
                let message = format!(
                    "Thread {thread_id} is in status {current} and will not reach idle by waiting \
                     alone. Inspect it with 'bb thread show {thread_id}' and recover by sending a \
                     follow-up."
                );
                return Err(wait_failure(message, "unreachable", 4));
            }
        } else {
            let remaining = deadline.saturating_duration_since(Instant::now()).as_millis() as u64;
            let wait_ms = remaining.min(MAX_EVENT_WAIT_MS).to_string();
            let query = [("type", event_type.as_str()), ("waitMs", wait_ms.as_str())];
            let event = call.http.get(&at(thread_id, "/events/wait"), &query)?;
            if !event.is_null() {
                let seq = text_of(&event, "seq");
                break format!("observed event {event_type} at seq {seq}");
            }
        }
        if Instant::now() >= deadline {
            let message = match &status {
                Some(status) => {
                    format!("Timed out waiting for thread {thread_id} to reach status {status}.")
                }
                None => format!("Timed out waiting for thread {thread_id} event {event_type}."),
            };
            return Err(wait_failure(message, "timeout", 2));
        }
        std::thread::sleep(Duration::from_millis(request.poll_interval_ms));
    };
    let data = json!({ "threadId": thread_id, "matched": true, "target": target });
    Ok(Output::text(data, format!("Thread {thread_id} {reached}.")))
}

fn thread_show(call: &mut Call) -> CliResult<Output> {
    let thread_id = thread_target(call)?;
    let thread = call.http.get(&at(&thread_id, ""), &[])?;
    let environment = match text(&thread, "environmentId").filter(|id| !id.is_empty()) {
        Some(id) => {
            call.http.get(&format!("/environments/{}", encode(id)), &[]).unwrap_or_default()
        }
        None => Value::Null,
    };
    let pending_todos = pending_todos_of(call, &thread_id);
    let mut lines = thread_lines(&thread, &environment);
    lines.extend(todo_lines(&pending_todos));
    let environment_id = text(&environment, "id").unwrap_or_default().to_string();
    let environment = match environment {
        Value::Object(mut fields) => {
            fields.insert("pullRequest".into(), pull_request_of(call, &environment_id));
            Value::Object(fields)
        }
        other => other,
    };
    let mut data =
        json!({ "thread": thread, "environment": environment, "pendingTodos": pending_todos });
    if environment_id.is_empty() || !call.on("work-status")? {
        return Ok(Output::lines(data, &lines));
    }
    let path = format!("/environments/{}/status", encode(&environment_id));
    let status = call.http.get(&path, &[])?;
    let available = text(&status, "outcome") == Some("available");
    data["workStatus"] = if available { status["workspace"].clone() } else { Value::Null };
    lines.push(String::new());
    lines.extend(work_lines(&status));
    Ok(Output::lines(data, &lines))
}

fn pull_request_of(call: &Call, environment_id: &str) -> Value {
    match pull_request_op(call, "get", json!({ "environmentId": environment_id })) {
        Ok(Value::Null) => json!({ "status": "none", "pullRequest": null }),
        Ok(pull) => json!({ "status": "available", "pullRequest": pull }),
        Err(error) => {
            json!({ "status": "unavailable", "pullRequest": null, "message": error.message })
        }
    }
}

fn work_lines(status: &Value) -> Vec<String> {
    match text(status, "outcome").unwrap_or_default() {
        "not_applicable" => {
            return vec![format!("Work status: {}", text(status, "message").unwrap_or_default())];
        }
        "available" => {}
        _ => {
            return vec![format!(
                "Work status: {}",
                text(&status["failure"], "message").unwrap_or_default()
            )];
        }
    }
    let tree = &status["workspace"]["workingTree"];
    let mut lines = vec![
        "Work status:".to_string(),
        format!("  State:    {}", text(tree, "state").unwrap_or_default()),
    ];
    let branch = text(&status["workspace"]["branch"], "currentBranch").unwrap_or_default();
    if !branch.is_empty() {
        lines.push(format!("  Branch:   {branch}"));
    }
    let files = tree["files"].as_array().map_or(0, Vec::len);
    lines.push(format!("  Changed files: {files}"));
    if tree["lineStatsComplete"].as_bool() == Some(true) {
        lines.push(format!("  Insertions:    +{}", tree["insertions"]));
        lines.push(format!("  Deletions:     -{}", tree["deletions"]));
    } else {
        lines.push("  Line stats: unavailable for untracked files".to_string());
    }
    let base = &status["workspace"]["mergeBase"];
    if base.is_object() {
        lines
            .push(format!("  Merge base:   {}", text(base, "mergeBaseBranch").unwrap_or_default()));
        lines.push(format!("  Ahead: {}  Behind: {}", base["aheadCount"], base["behindCount"]));
    }
    lines
}

fn log_events(call: &mut Call, thread_id: &str) -> CliResult<Output> {
    let wanted = if call.on("all")? {
        usize::MAX
    } else {
        let limit = integer(call.flag("limit")?.as_deref(), "--limit", 1)?;
        limit.map_or(EVENT_PAGE_SIZE, |n| n as usize)
    };
    let mut after = call.flag("after-seq")?;
    let mut rows: Vec<Value> = Vec::new();
    let limit = EVENT_PAGE_SIZE.to_string();
    let mut more = true;
    while more && rows.len() <= wanted {
        let mut query = Vec::new();
        if let Some(after) = &after {
            query.push(("afterSeq", after.as_str()));
        }
        query.push(("limit", limit.as_str()));
        let page = call.http.get(&at(thread_id, "/events"), &query)?;
        let page = page.as_array().cloned().unwrap_or_default();
        more = page.len() == EVENT_PAGE_SIZE;
        after = Some(page.last().map_or_else(|| "undefined".into(), |row| text_of(row, "seq")));
        rows.extend(page);
    }
    let total = rows.len();
    rows.truncate(wanted);
    if total > wanted {
        let last = rows.last().map_or_else(|| "undefined".into(), |row| text_of(row, "seq"));
        let next = format!("--after-seq {last} for the next page, or --all");
        eprintln!("Showing {} events; more exist. Use {next}.", rows.len());
    }
    Ok(Output::json(Value::Array(rows)))
}

fn thread_log(call: &mut Call) -> CliResult<Output> {
    use std::collections::HashSet;
    use std::io::IsTerminal;

    use bb_thread_view::rows::TimelineRow;

    use crate::log_text::format_timeline_text;

    const TIMELINE_TURN_LIMIT: u64 = 100;
    let thread_id = thread_target(call)?;
    let chosen = call.choice("format", &["minimal", "verbose", "json"])?;
    let format = if call.json() { "json" } else { chosen.unwrap_or("minimal") };
    let all = call.on("all")?;
    let limit = if all {
        Some(TIMELINE_TURN_LIMIT)
    } else {
        integer(call.flag("limit")?.as_deref(), "--limit", 1)?
    };
    if all && call.on("limit")? {
        return Err(usage_error("--all cannot be combined with --limit."));
    }
    if format != "json" && call.on("after-seq")? {
        return Err(usage_error("--after-seq is only supported with --format json."));
    }
    if format == "json" {
        return log_events(call, &thread_id);
    }
    if limit.is_some_and(|n| n > TIMELINE_TURN_LIMIT) {
        let most = format!("--limit is at most {TIMELINE_TURN_LIMIT} for the timeline");
        return Err(usage_error(format!("{most}; use --all for the whole thread.")));
    }
    let mut query: Vec<(&str, String)> = Vec::new();
    if format == "verbose" {
        query.push(("includeNestedRows", "true".into()));
    }
    if let Some(limit) = limit {
        query.push(("segmentLimit", limit.to_string()));
    }
    let path = at(&thread_id, "/timeline");
    let fetch = |call: &Call, extra: &[(&str, String)]| -> CliResult<(Vec<Value>, Value)> {
        let pairs: Vec<(&str, &str)> =
            query.iter().chain(extra).map(|(k, v)| (*k, v.as_str())).collect();
        let response = call.http.get(&path, &pairs)?;
        let rows = response.get("rows").and_then(Value::as_array).cloned().unwrap_or_default();
        let page = response.get("timelinePage").cloned().unwrap_or(Value::Null);
        Ok((rows, page))
    };
    let (mut rows, mut page) = fetch(call, &[])?;
    let older = |page: &Value| page.get("hasOlderRows").and_then(Value::as_bool) == Some(true);
    while all && older(&page) {
        let Some(cursor) = page.get("olderCursor").filter(|c| !c.is_null()) else { break };
        let extra = [
            ("beforeAnchorSeq", text_of(cursor, "anchorSeq")),
            ("beforeAnchorId", text_of(cursor, "anchorId")),
        ];
        let (older_rows, older_page) = fetch(call, &extra)?;
        let known: HashSet<String> = rows.iter().map(|row| text_of(row, "id")).collect();
        let mut merged: Vec<Value> =
            older_rows.into_iter().filter(|row| !known.contains(&text_of(row, "id"))).collect();
        merged.append(&mut rows);
        rows = merged;
        page = older_page;
    }
    let timeline: Vec<TimelineRow> = serde_json::from_value(Value::Array(rows))
        .map_err(|error| CliError::new(format!("Unexpected timeline response: {error}")))?;
    let no_color = std::env::var_os("NO_COLOR").is_some_and(|value| !value.is_empty());
    let color = std::io::stdout().is_terminal() && !no_color;
    let text = format_timeline_text(&timeline, format == "verbose", color);
    let notice = if older(&page) {
        format!(
            "\n\n(Showing the newest {} user-message turns; use --limit <n> (max 100) or --all for \
             older history.)",
            text_of(&page, "returnedSegmentCount")
        )
    } else {
        String::new()
    };
    call.print(&format!("{text}{notice}"))?;
    Ok(Output::Done)
}

fn thread_output(call: &mut Call) -> CliResult<Output> {
    let thread_id = thread_target(call)?;
    let result = call.http.get(&at(&thread_id, "/output"), &[])?;
    let output = text(&result, "output").filter(|o| !o.is_empty()).unwrap_or("(no output)");
    let output = output.to_string();
    Ok(Output::text(result, output))
}

fn thread_list(call: &mut Call) -> CliResult<Output> {
    if call.on("section")? && call.on("unsectioned")? {
        return Err(usage_error("Cannot combine --section with --unsectioned."));
    }
    let mut query: Vec<(&str, String)> = Vec::new();
    let mut add = |key, value: Option<String>| query.extend(value.map(|v| (key, v)));
    add("projectId", call.id("project")?);
    add("environmentId", call.id("environment")?);
    add("hostId", machine_flag(call)?);
    add("parentThreadId", call.id("parent-thread")?);
    add("sectionId", call.id("section")?);
    for (key, flag) in [
        ("archived", "archived"),
        ("unsectioned", "unsectioned"),
        ("includeHidden", "include-hidden"),
    ] {
        add(key, call.on(flag)?.then(|| "true".into()));
    }
    let query: Vec<(&str, &str)> = query.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let threads = call.http.get("/threads", &query)?;
    let list = threads.as_array().cloned().unwrap_or_default();
    let count = list.len();
    if call.on("count")? {
        return Ok(Output::text(json!({ "count": count }), count.to_string()));
    }
    let rows: Vec<Value> = list
        .into_iter()
        .map(|mut thread| {
            let title = thread.get("title").filter(|t| !t.is_null()).cloned();
            let title = title.or_else(|| thread.get("titleFallback").cloned());
            let archived = !matches!(thread.get("archivedAt"), None | Some(Value::Null));
            if let Value::Object(fields) = &mut thread {
                fields.insert("title".into(), title.unwrap_or(Value::Null));
                if archived {
                    fields.insert("status".into(), json!("archived"));
                }
            }
            thread
        })
        .collect();
    Ok(Output::rows(&rows, &["id", "title", "projectId", "status"], threads))
}

fn cleared(call: &Call, set: &str, clear: &str) -> CliResult<Option<Value>> {
    if call.on(set)? && call.on(clear)? {
        return Err(usage_error(format!("Cannot combine --{set} with --{clear}.")));
    }
    if call.on(clear)? {
        return Ok(Some(Value::Null));
    }
    Ok(call.id(set)?.map(Value::from))
}

fn thread_update(call: &mut Call) -> CliResult<Output> {
    let changes: Vec<(&str, Option<Value>)> = vec![
        ("title", call.flag("title")?.map(Value::from)),
        ("parentThreadId", cleared(call, "parent-thread", "clear-parent-thread")?),
        ("sectionId", cleared(call, "section", "clear-section")?),
        ("model", call.flag("model")?.map(Value::from)),
        ("reasoningLevel", call.choice("reasoning-level", REASONING_LEVELS)?.map(Value::from)),
        ("visibility", call.choice("visibility", VISIBILITIES)?.map(Value::from)),
    ];
    let changed: Vec<(&str, &Value)> =
        changes.iter().filter_map(|(key, value)| value.as_ref().map(|v| (*key, v))).collect();
    if changed.is_empty() {
        let options: Vec<&str> = changes.iter().map(|(key, _)| *key).collect();
        let hint = format!("Change one of: {}.", options.join(", "));
        return Err(usage_error("No changes requested.").hint(hint));
    }
    let thread_id = thread_target(call)?;
    let mut body = Map::new();
    for key in ["title", "sectionId", "parentThreadId", "model", "reasoningLevel", "visibility"] {
        if let Some((_, value)) = changed.iter().find(|(k, _)| *k == key) {
            body.insert(key.into(), (*value).clone());
        }
    }
    let thread = call.http.patch(&at(&thread_id, ""), &Value::Object(body))?;
    let mut lines = vec![format!("Thread {} updated", text_of(&thread, "id"))];
    for (key, value) in &changed {
        let value = if value.is_null() { "none".into() } else { shown(value) };
        lines.push(format!("  {key}: {value}"));
    }
    Ok(Output::lines(thread, &lines))
}

fn action(call: &mut Call, route: &str, acknowledged: bool, done: &str) -> CliResult<Output> {
    let thread_id = thread_target(call)?;
    let answer = call.http.request("POST", &at(&thread_id, route), &[], None)?;
    let result = if acknowledged { json!({ "ok": true }) } else { answer };
    let data = match result {
        Value::Object(mut fields) if fields.contains_key("ok") => {
            fields.insert("threadId".into(), json!(thread_id));
            Value::Object(fields)
        }
        other => other,
    };
    Ok(Output::text(data, format!("Thread {thread_id} {done}")))
}

fn thread_stop(call: &mut Call) -> CliResult<Output> {
    action(call, "/stop", true, "stopped")
}

fn thread_archive(call: &mut Call) -> CliResult<Output> {
    action(call, "/archive-all", false, "archived")
}

fn thread_unarchive(call: &mut Call) -> CliResult<Output> {
    action(call, "/unarchive", true, "unarchived")
}

fn thread_compact(call: &mut Call) -> CliResult<Output> {
    action(call, "/compact", true, "compaction requested")
}

fn thread_retry(call: &mut Call) -> CliResult<Output> {
    let thread_id = thread_target(call)?;
    let mut body = Map::new();
    put(&mut body, "sendAt", send_at(call)?);
    let response = call.http.post(&at(&thread_id, "/retry"), &Value::Object(body))?;
    let outcome = if text(&response, "delivery") == Some("queued") {
        let queued = response.get("queuedMessage").cloned().unwrap_or(Value::Null);
        format!("retry queued ({})", queue_wait(&queued))
    } else {
        "retry sent".into()
    };
    let mut data = Map::new();
    data.insert("threadId".into(), json!(thread_id));
    if let Value::Object(fields) = response {
        data.extend(fields);
    }
    Ok(Output::text(Value::Object(data), format!("Thread {thread_id} {outcome}")))
}

fn thread_clear(call: &mut Call) -> CliResult<Output> {
    action(call, "/context/clear", true, "context cleared")
}

fn thread_pin(call: &mut Call) -> CliResult<Output> {
    action(call, "/pin", false, "pinned")
}

fn thread_unpin(call: &mut Call) -> CliResult<Output> {
    action(call, "/unpin", false, "unpinned")
}

fn thread_read(call: &mut Call) -> CliResult<Output> {
    action(call, "/read", false, "marked read")
}

fn thread_unread(call: &mut Call) -> CliResult<Output> {
    action(call, "/unread", false, "marked unread")
}

fn thread_delete(call: &mut Call) -> CliResult<Output> {
    let thread_id = valid_id(call.arg("id")?, "<id> argument")?;
    confirm(call, &format!("Delete thread {thread_id} permanently?"))?;
    let body = json!({ "childThreadsConfirmed": call.on("confirm-child-threads")? });
    call.http.request("DELETE", &at(&thread_id, ""), &[], Some(&body))?;
    let data = json!({ "ok": true, "threadId": thread_id });
    Ok(Output::text(data, format!("Thread {thread_id} deleted")))
}

fn thread_search(call: &mut Call) -> CliResult<Output> {
    let limit = integer(call.flag("limit")?.as_deref(), "--limit", 1)?.map(|n| n.to_string());
    let query_text = call.arg("query")?.to_string();
    let mut query = Vec::new();
    if let Some(limit) = &limit {
        query.push(("limitPerGroup", limit.as_str()));
    }
    query.push(("query", query_text.as_str()));
    Ok(Output::json(call.http.get("/threads/search", &query)?))
}

fn normalize(path: &Path) -> PathBuf {
    let base = std::env::current_dir().unwrap_or_default();
    let mut out = PathBuf::new();
    for part in base.join(path).components() {
        match part {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

fn inside(root: Option<&str>, target: &str) -> Option<String> {
    let root = normalize(Path::new(root?));
    let rest = normalize(Path::new(target)).strip_prefix(&root).ok()?.to_path_buf();
    let parts: Vec<String> =
        rest.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn open_file(call: &Call, thread_id: &str, path: &str) -> CliResult<(&'static str, String)> {
    if !Path::new(path).is_absolute() {
        return Ok(("workspace", path.to_string()));
    }
    let own = call.env.thread_id.as_deref() == Some(thread_id);
    let storage = if own { call.env.thread_storage.as_deref() } else { None };
    if let Some(stored) = inside(storage, path) {
        return Ok(("thread-storage", stored));
    }
    let thread = call.http.get(&at(thread_id, ""), &[])?;
    let environment = match text(&thread, "environmentId") {
        Some(id) => call.http.get(&format!("/environments/{}", encode(id)), &[])?,
        None => Value::Null,
    };
    if let Some(local) = inside(text(&environment, "path"), path) {
        return Ok(("workspace", local));
    }
    let roots = "the thread's workspace or BB_THREAD_STORAGE";
    Err(usage_error(format!("An absolute path must be inside {roots}.")))
}

fn thread_open(call: &mut Call) -> CliResult<Output> {
    let first = call.args("id").map(String::from);
    let second = call.args("path").map(String::from);
    let current = call.env.thread_id.clone();
    let named = first
        .as_ref()
        .is_some_and(|first| second.is_some() || current.is_none() || first.starts_with("thr_"));
    let thread_id = match (named, &first) {
        (true, Some(first)) => Some(valid_id(first, "<id> argument")?),
        _ => current,
    };
    let Some(thread_id) = thread_id else {
        return Err(usage_error("Missing thread ID. Pass [id] or run inside a thread."));
    };
    let path = if named { second } else { first };
    let line_number = integer(call.flag("line")?.as_deref(), "--line", 1)?;
    if path.is_none() && line_number.is_some() {
        return Err(usage_error("--line requires a file path."));
    }
    let split = call.choice("split", OPEN_SPLITS)?;
    let file = match &path {
        None => Value::Null,
        Some(path) => {
            let (source, path) = open_file(call, &thread_id, path)?;
            json!({ "source": source, "path": path, "lineNumber": line_number })
        }
    };
    let mut body = Map::new();
    put(&mut body, "split", split);
    body.insert("file".into(), file.clone());
    let answer = call.http.post(&at(&thread_id, "/open"), &Value::Object(body))?;
    let delivered = answer.get("delivered").cloned().unwrap_or(Value::Null);
    let shown_path = text(&file, "path").map(|p| format!(" with {p}")).unwrap_or_default();
    let text = format!("Opened thread {thread_id}{shown_path} in {} window(s)", shown(&delivered));
    let data = json!({
        "threadId": thread_id,
        "split": split.unwrap_or("replace"),
        "file": file,
        "delivered": delivered,
    });
    Ok(Output::text(data, text))
}
