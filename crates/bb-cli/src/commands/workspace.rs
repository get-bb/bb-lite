use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};

use crate::call::{
    Call, CliError, CliResult, Handler, Output, confirm, integer, machine_flag, machine_id,
    machine_or_this, read_stdin, usage_error, valid_id,
};
use crate::http::encode;

const ENVIRONMENT_STATUSES: &[&str] = &["ready", "destroyed"];
const MANUAL_MACHINE_PROVIDER: &str = "manual";
const LOCAL_PATH: &str = "local_path";

/// Handlers ported from `apps/cli/src/commands/workspace.ts`.
pub fn handlers() -> Vec<(&'static str, Handler)> {
    vec![
        ("projectList", project_list),
        ("projectShow", project_show),
        ("projectCreate", project_create),
        ("projectUpdate", project_update),
        ("projectDelete", project_delete),
        ("projectSourceAdd", project_source_add),
        ("projectSourceUpdate", project_source_update),
        ("projectSourceDelete", project_source_delete),
        ("projectAttachmentUpload", project_attachment_upload),
        ("envList", env_list),
        ("envShow", env_show),
        ("envStatus", env_status),
        ("envCommit", env_commit),
        ("envUpdate", env_update),
        ("envDelete", env_delete),
        ("machineList", machine_list),
        ("machineShow", machine_show),
        ("machineAdd", machine_add),
        ("machineReconnect", machine_reconnect),
        ("machineRename", machine_rename),
        ("machineRemove", machine_remove),
        ("machineEnvList", machine_env_list),
        ("machineEnvSet", machine_env_set),
        ("machineEnvUnset", machine_env_unset),
        ("providerList", provider_list),
        ("providerModels", provider_models),
        ("providerEnable", provider_enable),
        ("providerDisable", provider_disable),
    ]
}

pub(crate) fn text(value: &Value, key: &str) -> String {
    match value.get(key) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

pub(crate) fn with(mut base: Value, extra: Value) -> Value {
    if let (Some(base), Value::Object(extra)) = (base.as_object_mut(), extra) {
        base.extend(extra);
    }
    base
}

/// Node's `path.resolve` against the current directory.
pub(crate) fn resolve_path(path: &str) -> String {
    let base = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    let mut out = PathBuf::from("/");
    for part in base.join(Path::new(path)).components() {
        match part {
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(name) => out.push(name),
            _ => {}
        }
    }
    out.to_string_lossy().into_owned()
}

fn id(call: &Call, name: &str) -> CliResult<String> {
    valid_id(call.arg(name)?, &format!("<{name}> argument"))
}

/// A `multipart/form-data` body with one `file` field, as `FormData` sends it.
pub fn file_form(boundary: &str, filename: &str, bytes: &[u8]) -> Vec<u8> {
    let escaped = filename.replace('"', "%22").replace('\r', "%0D").replace('\n', "%0A");
    let head = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{escaped}\"\r\n\
         Content-Type: application/octet-stream\r\n\r\n"
    );
    let mut body = head.into_bytes();
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

fn project_attachment_upload(call: &mut Call) -> CliResult<Output> {
    let file = required(call, "client-file")?;
    let project_id = id(call, "id")?;
    let bytes = std::fs::read(&file).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => {
            CliError::new(format!("ENOENT: no such file or directory, open '{file}'"))
        }
        _ => CliError::new(error.to_string()),
    })?;
    let filename = match call.flag("filename")? {
        Some(name) => name,
        None => Path::new(&file)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
    };
    if filename.trim().is_empty() {
        return Err(CliError::new("Project attachment filename must not be empty"));
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let boundary = format!("----bbFormBoundary{nanos:x}{}", std::process::id());
    let body = file_form(&boundary, &filename, &bytes);
    let content_type = format!("multipart/form-data; boundary={boundary}");
    let path = format!("/projects/{}/attachments", encode(&project_id));
    let uploaded = call.http.post_bytes(&path, &content_type, body)?;
    let shown = text(&uploaded, "path");
    Ok(Output::text(uploaded, shown))
}

fn required(call: &Call, name: &str) -> CliResult<String> {
    call.flag(name)?.ok_or_else(|| usage_error(format!("Missing required option --{name}.")))
}

fn project_list(call: &mut Call) -> CliResult<Output> {
    let include = if call.on("include-personal")? { "true" } else { "false" };
    let projects = call.http.get("/projects", &[("includePersonal", include)])?;
    let list = projects.as_array().cloned().unwrap_or_default();
    let rows: Vec<Value> = list
        .iter()
        .map(|project| {
            let sources = project.get("sources").and_then(Value::as_array);
            let places: Vec<String> = sources
                .into_iter()
                .flatten()
                .map(|s| format!("{}:{}", text(s, "hostId"), text(s, "path")))
                .collect();
            json!({ "id": project["id"], "name": project["name"], "sources": places.join(" ") })
        })
        .collect();
    Ok(Output::rows(&rows, &["id", "name", "sources"], projects))
}

fn project_show(call: &mut Call) -> CliResult<Output> {
    let project_id = id(call, "id")?;
    Ok(Output::json(call.http.get(&format!("/projects/{}", encode(&project_id)), &[])?))
}

fn project_create(call: &mut Call) -> CliResult<Output> {
    let name = required(call, "name")?;
    let path = resolve_path(&call.flag("root")?.unwrap_or_else(|| ".".into()));
    let host_id = machine_or_this(call)?;
    let source = json!({ "type": LOCAL_PATH, "hostId": host_id, "path": path });
    let project = call.http.post("/projects", &json!({ "name": name, "source": source }))?;
    let line = format!("Project {} created ({})", text(&project, "id"), text(&project, "name"));
    Ok(Output::text(project, line))
}

fn project_update(call: &mut Call) -> CliResult<Output> {
    let project_id = id(call, "id")?;
    let name = required(call, "name")?;
    let path = format!("/projects/{}", encode(&project_id));
    let project = call.http.patch(&path, &json!({ "name": name }))?;
    let line = format!("Project {} renamed to {}", text(&project, "id"), text(&project, "name"));
    Ok(Output::text(project, line))
}

fn project_delete(call: &mut Call) -> CliResult<Output> {
    let project_id = id(call, "id")?;
    confirm(call, &format!("Delete project {project_id} and all of its threads?"))?;
    call.http.delete(&format!("/projects/{}", encode(&project_id)), &[])?;
    let data = json!({ "ok": true, "projectId": project_id });
    Ok(Output::text(data, format!("Project {project_id} deleted")))
}

fn source_path(project_id: &str, source_id: &str) -> String {
    format!("/projects/{}/sources/{}", encode(project_id), encode(source_id))
}

fn project_source_add(call: &mut Call) -> CliResult<Output> {
    let project_id = id(call, "projectId")?;
    let path = required(call, "path")?;
    let host_id = machine_or_this(call)?;
    let body = json!({ "hostId": host_id, "path": path, "type": LOCAL_PATH });
    let added = call.http.post(&format!("/projects/{}/sources", encode(&project_id)), &body)?;
    let source = if call.on("default")? {
        let target = source_path(&project_id, &text(&added, "id"));
        call.http.patch(&target, &json!({ "isDefault": true, "type": LOCAL_PATH }))?
    } else {
        added
    };
    let line = format!("Source {} added to project {project_id}", text(&source, "id"));
    Ok(Output::text(source, line))
}

fn project_source_update(call: &mut Call) -> CliResult<Output> {
    let target = source_path(&id(call, "projectId")?, &id(call, "sourceId")?);
    let mut body = Map::new();
    if call.on("default")? {
        body.insert("isDefault".into(), json!(true));
    }
    if let Some(path) = call.flag("path")? {
        body.insert("path".into(), json!(path));
    }
    body.insert("type".into(), json!(LOCAL_PATH));
    let source = call.http.patch(&target, &Value::Object(body))?;
    let line = format!("Source {} updated", text(&source, "id"));
    Ok(Output::text(source, line))
}

fn project_source_delete(call: &mut Call) -> CliResult<Output> {
    let (project_id, source_id) = (id(call, "projectId")?, id(call, "sourceId")?);
    confirm(call, &format!("Delete project source {source_id}?"))?;
    call.http.delete(&source_path(&project_id, &source_id), &[])?;
    let data = json!({ "ok": true, "projectId": project_id, "sourceId": source_id });
    Ok(Output::text(data, format!("Source {source_id} deleted")))
}

fn env_list(call: &mut Call) -> CliResult<Output> {
    let project_id = call.id("project")?;
    let host_id = machine_flag(call)?;
    let status = call.choice("status", ENVIRONMENT_STATUSES)?;
    let limit = integer(call.flag("limit")?.as_deref(), "--limit", 1)?.map(|n| n.to_string());
    let mut query: Vec<(&str, &str)> = Vec::new();
    let pairs = [
        ("projectId", project_id.as_deref()),
        ("hostId", host_id.as_deref()),
        ("status", status),
        ("limit", limit.as_deref()),
    ];
    query.extend(pairs.iter().filter_map(|(k, v)| v.map(|v| (*k, v))));
    let environments = call.http.get("/environments", &query)?;
    let rows = environments.as_array().cloned().unwrap_or_default();
    Ok(Output::rows(&rows, &["id", "hostId", "branchName", "status", "path"], environments))
}

fn environment_path(environment_id: &str, suffix: &str) -> String {
    format!("/environments/{}{suffix}", encode(environment_id))
}

fn env_show(call: &mut Call) -> CliResult<Output> {
    let path = environment_path(&id(call, "id")?, "");
    Ok(Output::json(call.http.get(&path, &[])?))
}

fn env_status(call: &mut Call) -> CliResult<Output> {
    let path = environment_path(&id(call, "id")?, "/status");
    let base = call.flag("merge-base-branch")?;
    let query: Vec<(&str, &str)> = base.iter().map(|b| ("mergeBaseBranch", b.as_str())).collect();
    Ok(Output::json(call.http.get(&path, &query)?))
}

fn env_commit(call: &mut Call) -> CliResult<Output> {
    let path = environment_path(&id(call, "id")?, "/actions");
    let result = call.http.post(&path, &json!({ "action": "commit" }))?;
    let message = text(&result, "message");
    Ok(Output::text(result, message))
}

fn cleared(call: &Call, set: &str, clear: &str) -> CliResult<Option<Value>> {
    if call.on(set)? && call.on(clear)? {
        return Err(usage_error(format!("Cannot combine --{set} with --{clear}.")));
    }
    if call.on(clear)? {
        return Ok(Some(Value::Null));
    }
    Ok(call.flag(set)?.map(Value::String))
}

fn env_update(call: &mut Call) -> CliResult<Output> {
    let name = cleared(call, "name", "clear-name")?;
    let base = cleared(call, "merge-base-branch", "clear-merge-base-branch")?;
    let environment_id = id(call, "id")?;
    if name.is_none() && base.is_none() {
        return Err(usage_error("Nothing to change; pass --name or --merge-base-branch."));
    }
    let mut body = Map::new();
    if let Some(base) = base {
        body.insert("mergeBaseBranch".into(), base);
    }
    if let Some(name) = name {
        body.insert("name".into(), name);
    }
    let path = environment_path(&environment_id, "");
    let environment = call.http.patch(&path, &Value::Object(body))?;
    let line = format!("Environment {} updated", text(&environment, "id"));
    Ok(Output::text(environment, line))
}

fn env_delete(call: &mut Call) -> CliResult<Output> {
    let environment_id = id(call, "id")?;
    confirm(call, &format!("Delete environment {environment_id} and its worktree?"))?;
    call.http.delete(&environment_path(&environment_id, ""), &[])?;
    let data = json!({ "ok": true, "environmentId": environment_id });
    Ok(Output::text(data, format!("Environment {environment_id} deleted")))
}

fn machine_list(call: &mut Call) -> CliResult<Output> {
    let hosts = call.http.get("/hosts", &[("includeCreating", "true")])?;
    let rows = hosts.as_array().cloned().unwrap_or_default();
    Ok(Output::rows(&rows, &["id", "name", "status", "lastSeenAt"], hosts))
}

fn join_instructions(join: &Value) -> Vec<String> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64);
    let expires_at = join.get("expiresAt").and_then(Value::as_f64).unwrap_or(0.0);
    let minutes = ((expires_at - now) / 60_000.0 + 0.5).floor().max(1.0);
    vec![
        format!(
            "Run this on the machine within {minutes} minutes, then start it with `bb runner run`:"
        ),
        text(join, "command"),
    ]
}

fn host_path(host_id: &str, suffix: &str) -> String {
    format!("/hosts/{}{suffix}", encode(host_id))
}

fn machine_show(call: &mut Call) -> CliResult<Output> {
    let host_id = machine_id(call, call.arg("machine")?)?;
    Ok(Output::json(call.http.get(&host_path(&host_id, ""), &[])?))
}

fn machine_add(call: &mut Call) -> CliResult<Output> {
    let request = json!({ "machineProviderId": MANUAL_MACHINE_PROVIDER, "inputs": null });
    let created = call.http.post("/hosts", &request)?;
    let host_id = text(&created, "id");
    let host = match call.flag("name")? {
        None => created,
        Some(name) => call.http.patch(&host_path(&host_id, ""), &json!({ "name": name }))?,
    };
    let join = call.http.get(&host_path(&host_id, "/enrollment-command"), &[])?;
    if join.is_null() {
        return Err(CliError::new(format!("Machine {host_id} has no join command.")));
    }
    let mut lines = vec![format!("Machine {host_id} added.")];
    lines.extend(join_instructions(&join));
    Ok(Output::lines(with(json!({ "host": host }), join), &lines))
}

fn machine_reconnect(call: &mut Call) -> CliResult<Output> {
    let host_id = machine_id(call, call.arg("machine")?)?;
    let path = host_path(&host_id, "/reconnect-commands");
    let join = call.http.request("POST", &path, &[], None)?;
    let lines = join_instructions(&join);
    Ok(Output::lines(join, &lines))
}

fn machine_rename(call: &mut Call) -> CliResult<Output> {
    let host_id = machine_id(call, call.arg("machine")?)?;
    let body = json!({ "name": call.arg("name")? });
    let host = call.http.patch(&host_path(&host_id, ""), &body)?;
    let line = format!("Machine {} renamed to {}", text(&host, "id"), text(&host, "name"));
    Ok(Output::text(host, line))
}

fn machine_remove(call: &mut Call) -> CliResult<Output> {
    let host_id = machine_id(call, call.arg("machine")?)?;
    confirm(call, &format!("Remove machine {host_id}?"))?;
    call.http.delete(&host_path(&host_id, ""), &[])?;
    let data = json!({ "ok": true, "hostId": host_id });
    Ok(Output::text(data, format!("Machine {host_id} removed")))
}

#[derive(PartialEq)]
enum Change {
    Set,
    Unset,
}

fn variables(call: &Call, change: Option<Change>) -> CliResult<Value> {
    let project_id = call.id("project")?;
    let path = match &project_id {
        None => "/settings/machine-environment".to_string(),
        Some(project) => format!("/projects/{}/machine-environment", encode(project)),
    };
    let current = call.http.get(&path, &[])?;
    let Some(change) = change else { return Ok(current) };
    let name = call.arg("name")?;
    let listed = current.get("variables").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut next: Vec<Value> = listed
        .iter()
        .filter(|variable| text(variable, "name") != name)
        .map(|v| json!({ "name": v["name"], "value": null, "note": v["note"] }))
        .collect();
    if change == Change::Set {
        let stdin = String::from_utf8_lossy(&read_stdin()?).into_owned();
        let value =
            stdin.strip_suffix('\n').map_or(stdin.as_str(), |v| v.strip_suffix('\r').unwrap_or(v));
        let note = call.flag("note")?;
        next.push(json!({ "name": name, "value": value, "note": note }));
    }
    call.http.put(&path, &json!({ "variables": next }))
}

fn machine_env_list(call: &mut Call) -> CliResult<Output> {
    let list = variables(call, None)?;
    let rows = list.get("variables").and_then(Value::as_array).cloned().unwrap_or_default();
    Ok(Output::rows(&rows, &["name", "note"], list))
}

fn machine_env_set(call: &mut Call) -> CliResult<Output> {
    let result = variables(call, Some(Change::Set))?;
    Ok(Output::text(result, format!("{} set", call.arg("name")?)))
}

fn machine_env_unset(call: &mut Call) -> CliResult<Output> {
    let result = variables(call, Some(Change::Unset))?;
    Ok(Output::text(result, format!("{} removed", call.arg("name")?)))
}

fn routing(call: &Call) -> CliResult<Vec<(&'static str, String)>> {
    let host_id = machine_flag(call)?;
    let environment_id = call.id("environment")?;
    match (host_id, environment_id) {
        (Some(_), Some(_)) => Err(usage_error("Cannot combine --machine with --environment.")),
        (_, Some(environment_id)) => Ok(vec![("environmentId", environment_id)]),
        (Some(host_id), None) => Ok(vec![("hostId", host_id)]),
        (None, None) => Ok(Vec::new()),
    }
}

fn borrowed<'q>(query: &'q [(&'static str, String)]) -> Vec<(&'static str, &'q str)> {
    query.iter().map(|(k, v)| (*k, v.as_str())).collect()
}

fn provider_list(call: &mut Call) -> CliResult<Output> {
    if call.on("all")? {
        let catalog = call.http.get("/system/providers/catalog", &[])?;
        let rows = catalog.as_array().cloned().unwrap_or_default();
        return Ok(Output::rows(&rows, &["id", "displayName", "enabled", "available"], catalog));
    }
    let query = routing(call)?;
    let providers = call.http.get("/system/providers", &borrowed(&query))?;
    let rows = providers.as_array().cloned().unwrap_or_default();
    Ok(Output::rows(&rows, &["id", "displayName"], providers))
}

fn provider_models(call: &mut Call) -> CliResult<Output> {
    let mut query = routing(call)?;
    if let Some(provider_id) = call.args("providerId") {
        query.push(("providerId", provider_id.to_string()));
    }
    let options = call.http.get("/system/execution-options", &borrowed(&query))?;
    if let Some(error) = options.get("modelLoadError").filter(|e| !e.is_null()) {
        let detail = match error.get("detail") {
            None | Some(Value::Null) => String::new(),
            Some(_) => format!(": {}", text(error, "detail")),
        };
        let (provider, code) = (text(error, "providerId"), text(error, "code"));
        eprintln!("Could not load models for {provider} ({code}{detail})");
    }
    let models = options.get("models").cloned().unwrap_or(Value::Null);
    let rows = models.as_array().cloned().unwrap_or_default();
    Ok(Output::rows(&rows, &["model", "displayName", "isDefault"], models))
}

fn set_provider_enabled(call: &mut Call, enabled: bool) -> CliResult<Output> {
    let provider_id = call.arg("providerId")?.to_string();
    let path = format!("/system/providers/{}/enabled", encode(&provider_id));
    let catalog = call.http.put(&path, &json!({ "enabled": enabled }))?;
    let state = if enabled { "enabled" } else { "disabled" };
    Ok(Output::text(catalog, format!("{provider_id} {state}")))
}

fn provider_enable(call: &mut Call) -> CliResult<Output> {
    set_provider_enabled(call, true)
}

fn provider_disable(call: &mut Call) -> CliResult<Output> {
    set_provider_enabled(call, false)
}
