use serde_json::Value;

use crate::call::{Call, locale_date};
use crate::http::encode;

/// A string field of a JSON object, or `None` when it is missing, null or not a string.
pub fn text<'v>(value: &'v Value, key: &str) -> Option<&'v str> {
    value.get(key).and_then(Value::as_str)
}

/// The text of a JSON value the way a JavaScript template literal prints it.
pub fn shown(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".into(),
        other => other.to_string(),
    }
}

fn date(value: Option<&Value>) -> String {
    locale_date(value.and_then(Value::as_f64).unwrap_or(0.0))
}

fn truthy(value: Option<&Value>) -> Option<String> {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => None,
        Some(Value::String(text)) if text.is_empty() => None,
        Some(other) => Some(shown(other)),
    }
}

/// `pendingTodosOf`: the TODOs of a thread's timeline summary, or null when it cannot be read.
pub fn pending_todos_of(call: &Call, thread_id: &str) -> Value {
    let path = format!("/threads/{}/timeline", encode(thread_id));
    let summary = call.http.get(&path, &[("summaryOnly", "true")]).unwrap_or(Value::Null);
    summary.get("pendingTodos").cloned().unwrap_or(Value::Null)
}

pub fn todo_lines(todos: &Value) -> Vec<String> {
    let items = todos.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
    if items.is_empty() {
        return Vec::new();
    }
    let status = |item: &Value| text(item, "status").unwrap_or("").to_string();
    let done = items.iter().filter(|item| status(item) == "completed").count();
    let mut lines = vec![String::new(), format!("TODOs ({done}/{} done):", items.len())];
    for item in &items {
        let mark = match status(item).as_str() {
            "in_progress" => "[>]",
            "pending" => "[ ]",
            "completed" => "[x]",
            _ => "undefined",
        };
        lines.push(format!("  {mark} {}", text(item, "text").unwrap_or("")));
    }
    lines
}

pub fn thread_lines(thread: &Value, environment: &Value) -> Vec<String> {
    let place = if environment.is_null() {
        truthy(thread.get("environmentId"))
    } else {
        let path = text(environment, "path").unwrap_or("no path");
        let id = text(environment, "id").unwrap_or("");
        let host = text(environment, "hostId").unwrap_or("");
        Some(format!("{id} on {host} ({path})"))
    };
    let field = |key: &str| thread.get(key).map(shown).unwrap_or_else(|| "undefined".into());
    let set = |key: &str| !matches!(thread.get(key), None | Some(Value::Null));
    let lines = [
        format!("Thread: {}", field("id")),
        format!("  Status: {}", field("status")),
        truthy(thread.get("title")).map(|t| format!("  Title: {t}")).unwrap_or_default(),
        format!("  Project: {}", field("projectId")),
        truthy(thread.get("parentThreadId")).map(|p| format!("  Parent: {p}")).unwrap_or_default(),
        if set("archivedAt") {
            format!("  Archived: {}", date(thread.get("archivedAt")))
        } else {
            String::new()
        },
        if set("pinnedAt") {
            format!("  Pinned: {}", date(thread.get("pinnedAt")))
        } else {
            String::new()
        },
        place.filter(|p| !p.is_empty()).map(|p| format!("  Environment: {p}")).unwrap_or_default(),
        format!("  Created: {}", date(thread.get("createdAt"))),
        format!("  Updated: {}", date(thread.get("updatedAt"))),
    ];
    lines.into_iter().filter(|line| !line.is_empty()).collect()
}

pub fn queue_wait(row: &Value) -> String {
    let waiting_on = row.get("waitingOn").filter(|w| !w.is_null());
    let kind = waiting_on.and_then(|w| text(w, "kind")).unwrap_or("thread-busy");
    let field = |key: &str| waiting_on.and_then(|w| text(w, key)).unwrap_or("").to_string();
    match kind {
        "time" => match row.get("sendAt").filter(|at| !at.is_null()) {
            None => "scheduled".into(),
            Some(at) => format!("due {}", date(Some(at))),
        },
        "host-offline" => format!("waiting for {} to reconnect", field("hostName")),
        "plugin" => format!("{}: {}", field("pluginId"), field("reason")),
        "thread-busy" => "waiting for the current turn to finish".into(),
        "stopping" => "sending once the thread finishes stopping".into(),
        "turn-starting" => "waiting for the current turn to start".into(),
        "provisioning" => "waiting for the workspace".into(),
        "interaction" => "waiting for a pending interaction".into(),
        _ => "undefined".into(),
    }
}
