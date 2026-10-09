use std::io::Write;
use std::path::Path;

use serde_json::{Map, Value, json};

use crate::call::CliEnv;
use crate::call::{
    Call, CliError, CliResult, Handler, Output, confirm, integer, machine_flag, parse_json,
    read_stdin, usage_error,
};
use crate::commands::workspace::{resolve_path, text};
use crate::http::encode;
use crate::render::{pending_todos_of, shown, thread_lines, todo_lines};

const KEYBINDING: &str = "keybinding.";
const UI: &str = "ui.";
const UNBOUND: &str = "none";
const MODIFIERS: [&str; 5] = ["mod", "meta", "control", "alt", "shift"];

/// Handlers ported from `apps/cli/src/commands/system.ts`.
pub fn handlers() -> Vec<(&'static str, Handler)> {
    vec![
        ("status", status),
        ("guide", crate::guide::guide),
        ("fileRead", file_read),
        ("fileWrite", file_write),
        ("fileList", file_list),
        ("settingsShow", settings_show),
        ("pluginList", plugin_list),
        ("pluginReload", plugin_reload),
        ("pluginAdd", plugin_add),
        ("pluginRemove", plugin_remove),
        ("serverStatus", server_status),
        ("settingsSet", settings_set),
        ("settingsReset", settings_reset),
        ("settingsGet", settings_show),
        ("pluginEnable", plugin_enable),
        ("pluginDisable", plugin_disable),
    ]
}

fn quiet(call: &Call, path: &str, query: &[(&str, &str)]) -> Value {
    call.http.get(path, query).unwrap_or(Value::Null)
}

fn status(call: &mut Call) -> CliResult<Output> {
    let CliEnv { project_id, thread_id, server_url, .. } = call.env.clone();
    let config = quiet(call, "/server/config", &[]);
    let project = match &project_id {
        Some(id) => quiet(call, &format!("/projects/{}", encode(id)), &[]),
        None => Value::Null,
    };
    let thread = match &thread_id {
        Some(id) => quiet(call, &format!("/threads/{}", encode(id)), &[]),
        None => Value::Null,
    };
    let environment = match thread["environmentId"].as_str() {
        Some(id) => quiet(call, &format!("/environments/{}", encode(id)), &[]),
        None => Value::Null,
    };
    let (children, pending_todos) = match thread["id"].as_str() {
        Some(id) => {
            let children = quiet(call, "/threads", &[("parentThreadId", id)]);
            (children, pending_todos_of(call, id))
        }
        None => (Value::Null, Value::Null),
    };
    let listed = if config.is_null() { Value::Null } else { quiet(call, "/plugins", &[]) };
    let child_threads = children.as_array().map(|rows| {
        let pick =
            |row: &Value| json!({"id": row["id"], "status": row["status"], "title": row["title"]});
        rows.iter().map(pick).collect::<Vec<_>>()
    });
    let plugins = listed["plugins"].as_array().cloned().unwrap_or_default();
    let needing: Vec<Value> = plugins
        .iter()
        .filter(|plugin| plugin["enabled"] == json!(true) && plugin["status"] != json!("running"))
        .map(|plugin| json!({"id": plugin["id"], "status": plugin["status"]}))
        .collect();
    let thread_data = match &thread {
        Value::Object(fields) => {
            let mut fields = fields.clone();
            fields.insert("environment".into(), environment.clone());
            Value::Object(fields)
        }
        _ => Value::Null,
    };
    let data = json!({
        "project": if project.is_object() {
            json!({"id": project["id"], "name": project["name"]})
        } else {
            Value::Null
        },
        "thread": thread_data,
        "childThreads": child_threads,
        "pendingTodos": pending_todos,
        "pluginsNeedingAttention": needing,
        "dataDir": config.get("dataDir").cloned().unwrap_or(Value::Null),
        "serverUrl": server_url,
    });
    let mut lines = vec![if project.is_object() {
        format!("Project: {} ({})", shown(&project["name"]), shown(&project["id"]))
    } else {
        format!("Project: {}", project_id.as_deref().unwrap_or("(not set)"))
    }];
    lines.push(String::new());
    if thread.is_object() {
        lines.extend(thread_lines(&thread, &environment));
    } else {
        lines.push(format!("Thread: {}", thread_id.as_deref().unwrap_or("(not set)")));
    }
    let child_lines: Vec<String> = child_threads
        .unwrap_or_default()
        .iter()
        .map(|child| {
            let title = child["title"].as_str().unwrap_or("");
            format!("  {}  {}  {title}", shown(&child["id"]), shown(&child["status"]))
        })
        .collect();
    if !child_lines.is_empty() {
        lines.extend([String::new(), "Child threads:".into()]);
        lines.extend(child_lines);
    }
    lines.extend(todo_lines(&pending_todos));
    lines.push(String::new());
    lines.push(if config.is_null() {
        format!("Server: {server_url} is not reachable")
    } else {
        format!("Server: {server_url} (data in {})", shown(&config["dataDir"]))
    });
    for plugin in &needing {
        let (id, status) = (shown(&plugin["id"]), shown(&plugin["status"]));
        lines.push(format!("Plugin {id} is not running ({status})."));
    }
    Ok(Output::lines(data, &lines))
}

fn host_path(call: &Call) -> CliResult<Map<String, Value>> {
    let mut body = Map::new();
    if let Some(host_id) = machine_flag(call)? {
        body.insert("hostId".into(), json!(host_id));
    }
    body.insert("path".into(), json!(call.arg("path")?));
    Ok(body)
}

fn put_some(body: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        body.insert(key.into(), value);
    }
}

fn write_out(call: &mut Call, bytes: &[u8]) -> CliResult<()> {
    let written = call.stdout.write_all(bytes).and_then(|()| call.stdout.flush());
    written.map_err(|e| CliError::new(e.to_string()))
}

fn file_read(call: &mut Call) -> CliResult<Output> {
    let mut body = host_path(call)?;
    put_some(&mut body, "rootPath", call.flag("root")?.map(Value::String));
    let file = call.http.post("/machines/files/read", &Value::Object(body))?;
    if call.json() {
        return Ok(Output::json(file));
    }
    let trailing = if text(&file, "contentEncoding") == "utf8" { "" } else { "\n" };
    write_out(call, format!("{}{trailing}", text(&file, "content")).as_bytes())?;
    Ok(Output::Done)
}

fn file_write(call: &mut Call) -> CliResult<Output> {
    let inline = call.flag("content")?;
    if inline.is_none() != call.on("stdin")? {
        return Err(usage_error("Provide exactly one of --content or --stdin."));
    }
    let mut body = host_path(call)?;
    put_some(&mut body, "rootPath", call.flag("root")?.map(Value::String));
    let content = match inline {
        Some(content) => content,
        None => String::from_utf8_lossy(&read_stdin()?).into_owned(),
    };
    body.insert("content".into(), json!(content));
    put_some(&mut body, "createParents", call.on("create-parents")?.then_some(json!(true)));
    put_some(&mut body, "expectedSha256", call.flag("expected-sha256")?.map(Value::String));
    let result = call.http.post("/machines/files/write", &Value::Object(body))?;
    let outcome =
        if text(&result, "outcome") == "written" { "Wrote" } else { "Write conflict for" };
    let line = format!("{outcome} {}", call.arg("path")?);
    Ok(Output::text(result, line))
}

fn file_list(call: &mut Call) -> CliResult<Output> {
    let located = host_path(call)?;
    let query = call.flag("query")?;
    let limit = integer(call.flag("limit")?.as_deref(), "--limit", 1)?;
    let mut body = Map::new();
    put_some(&mut body, "hostId", located.get("hostId").cloned());
    put_some(&mut body, "limit", limit.map(Value::from));
    put_some(&mut body, "path", located.get("path").cloned());
    put_some(&mut body, "query", query.map(Value::String));
    let result = call.http.post("/machines/files/list", &Value::Object(body))?;
    let files = result.get("files").and_then(Value::as_array);
    let paths: Vec<String> = files.into_iter().flatten().map(|f| text(f, "path")).collect();
    Ok(Output::lines(result, &paths))
}

fn read_settings(call: &Call) -> CliResult<Map<String, Value>> {
    let config = call.http.get("/server/config", &[])?;
    let ui = call.http.get("/settings/ui-preferences", &[])?;
    let mut settings = config["generalSettings"].as_object().cloned().unwrap_or_default();
    let appearance = &config["appearance"];
    settings.insert("theme".into(), appearance["themeId"].clone());
    settings.insert("theme.faviconColor".into(), appearance["faviconColor"].clone());
    let overrides = config["keybindingOverrides"].as_array().cloned().unwrap_or_default();
    for item in overrides {
        let shortcut = &item["shortcut"];
        let keys = if shortcut.is_null() {
            UNBOUND.to_string()
        } else {
            let truthy = |name: &&&str| shortcut[**name].as_bool().unwrap_or(false);
            let mut held: Vec<String> =
                MODIFIERS.iter().filter(truthy).map(|m| m.to_string()).collect();
            held.push(text(shortcut, "key"));
            held.join("+")
        };
        settings.insert(format!("{KEYBINDING}{}", text(&item, "command")), json!(keys));
    }
    let preferences = ui["preferences"].as_object().cloned().unwrap_or_default();
    for (key, entry) in preferences {
        settings.insert(format!("{UI}{key}"), entry["value"].clone());
    }
    Ok(settings)
}

fn setting_value(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or_else(|_| json!(raw))
}

fn default_setting(key: &str) -> Option<Value> {
    let defaults = json!({
        "showKeyboardHints": true,
        "steerActiveThreadOnEnter": true,
        "confirmThreadArchive": true,
        "showDiagnosticEvents": false,
        "providerOrder": [],
        "defaultProviderId": null,
        "providerCompletedTurnDisplay": {},
        "streamerMode": false,
        "allowFastServiceTier": true,
        "telemetryEnabled": true,
        "managedBranchPrefix": "bb/",
        "machineServerUrl": null,
        "defaultMachineAccess": null,
        "machineGitCredentialsEnabled": true,
    });
    defaults.get(key).cloned()
}

fn write_setting(call: &Call, key: &str, raw: Option<&str>) -> CliResult<Value> {
    let config = call.http.get("/server/config", &[])?;
    if key == "theme" || key == "theme.faviconColor" {
        let mut selection = json!({
            "themeId": config["appearance"]["themeId"],
            "faviconColor": config["appearance"]["faviconColor"],
        });
        let field = if key == "theme" { "themeId" } else { "faviconColor" };
        selection[field] = json!(raw.unwrap_or("default"));
        return call.http.put("/settings/appearance", &selection);
    }
    if let Some(command) = key.strip_prefix(KEYBINDING) {
        let current = config["keybindingOverrides"].as_array().cloned().unwrap_or_default();
        let mut overrides: Vec<Value> =
            current.into_iter().filter(|o| text(o, "command") != command).collect();
        if let Some(raw) = raw {
            let lowered = raw.to_lowercase().replacen("ctrl", "control", 1);
            let held: Vec<&str> = lowered.split('+').collect();
            let mut combination = json!({ "key": held.last() });
            for name in MODIFIERS {
                combination[name] = json!(held.contains(&name));
            }
            let shortcut = if raw == UNBOUND { Value::Null } else { combination };
            overrides.push(json!({ "command": command, "shortcut": shortcut }));
        }
        return call.http.put("/settings/keyboard", &Value::Array(overrides));
    }
    if let Some(name) = key.strip_prefix(UI) {
        let listed = call.http.get("/settings/ui-preferences", &[])?;
        let preferences = listed["preferences"].as_object().cloned().unwrap_or_default();
        let Some(entry) = preferences.get(name) else {
            let known: Vec<&str> = preferences.keys().map(String::as_str).collect();
            let message = format!("Unknown UI preference '{name}'.");
            return Err(usage_error(message).hint(format!("Known: {}", known.join(", "))));
        };
        let path = format!("/settings/ui-preferences/{}", encode(name));
        let Some(raw) = raw else { return call.http.delete(&path, &[]) };
        let body = json!({ "expectedRevision": entry["revision"], "value": setting_value(raw) });
        return call.http.put(&path, &body);
    }
    let Some(default) = default_setting(key) else {
        let hint = "Run `bb settings show` for the keys.";
        return Err(usage_error(format!("Unknown setting '{key}'.")).hint(hint));
    };
    let value = raw.map_or(default, setting_value);
    let mut changed = config["generalSettings"].as_object().cloned().unwrap_or_default();
    changed.insert(key.into(), value);
    call.http.put("/settings/general", &Value::Object(changed))
}

fn change_setting(call: &mut Call, reset: bool) -> CliResult<Output> {
    let key = call.arg("key")?.to_string();
    let raw = if reset { None } else { Some(call.arg("value")?.to_string()) };
    write_setting(call, &key, raw.as_deref())?;
    let value = read_settings(call)?.remove(&key).unwrap_or(Value::Null);
    let line = format!("{key} = {value}");
    Ok(Output::text(json!({ "key": key, "value": value }), line))
}

fn settings_set(call: &mut Call) -> CliResult<Output> {
    change_setting(call, false)
}

fn settings_reset(call: &mut Call) -> CliResult<Output> {
    change_setting(call, true)
}

fn settings_show(call: &mut Call) -> CliResult<Output> {
    let settings = read_settings(call)?;
    let key = call.args("key").map(String::from);
    let shown: Vec<(&String, &Value)> =
        settings.iter().filter(|(name, _)| key.as_ref().is_none_or(|k| k == *name)).collect();
    if shown.is_empty() {
        let key = key.as_deref().unwrap_or("undefined");
        return Err(usage_error(format!("Unknown setting '{key}'.")));
    }
    let lines: Vec<String> = shown
        .iter()
        .map(|(name, value)| match (&key, value) {
            (None, value) => format!("{name} = {value}"),
            (Some(_), Value::String(text)) => text.clone(),
            (Some(_), value) => value.to_string(),
        })
        .collect();
    let data = match &key {
        None => Value::Object(settings.clone()),
        Some(key) => json!({ "key": key, "value": settings[key] }),
    };
    Ok(Output::lines(data, &lines))
}

fn plugin_list(call: &mut Call) -> CliResult<Output> {
    let result = call.http.get("/plugins", &[])?;
    let plugins = result["plugins"].as_array().cloned().unwrap_or_default();
    let rows: Vec<Value> = plugins
        .iter()
        .map(|plugin| {
            let commands = plugin["cliCommands"].as_array().cloned().unwrap_or_default();
            let names: Vec<String> =
                commands.iter().map(|c| format!("bb {}", text(c, "name"))).collect();
            let about = match &plugin["statusMessage"] {
                Value::Null => plugin["description"].clone(),
                message => message.clone(),
            };
            json!({
                "id": plugin["id"],
                "status": plugin["status"],
                "commands": names.join(", "),
                "about": about,
            })
        })
        .collect();
    Ok(Output::rows(&rows, &["id", "status", "commands", "about"], result))
}

fn set_plugin_enabled(call: &mut Call, verb: &str) -> CliResult<Output> {
    let plugin_id = call.arg("id")?;
    if plugin_id.is_empty() {
        return Err(CliError::new("Too small: expected string to have >=1 characters"));
    }
    let path = format!("/plugins/{}/{verb}", encode(plugin_id));
    let toggled = call.http.post(&path, &json!({}))?;
    let plugin = toggled["plugin"].clone();
    let line = format!("Plugin {} is {}", text(&plugin, "id"), text(&plugin, "status"));
    Ok(Output::text(plugin, line))
}

fn plugin_enable(call: &mut Call) -> CliResult<Output> {
    set_plugin_enabled(call, "enable")
}

fn plugin_disable(call: &mut Call) -> CliResult<Output> {
    set_plugin_enabled(call, "disable")
}

fn reload(call: &Call, plugin_id: Option<&str>) -> CliResult<Value> {
    let body = plugin_id.map_or_else(|| json!({}), |id| json!({ "id": id }));
    call.http.request("POST", "/plugins/reload", &[], Some(&body))
}

fn plugin_reload(call: &mut Call) -> CliResult<Output> {
    let plugin_id = call.args("id").map(String::from);
    let result = reload(call, plugin_id.as_deref())?;
    let count = result["plugins"].as_array().map_or(0, Vec::len);
    let what = plugin_id.unwrap_or_else(|| format!("{count} plugins"));
    Ok(Output::text(result, format!("Reloaded {what}")))
}

fn edit_plugin_config(call: &mut Call, add: bool) -> CliResult<Output> {
    let path = resolve_path(call.arg("path")?);
    let config = call.http.get("/server/config", &[])?;
    let file = Path::new(&text(&config, "dataDir")).join("config.json");
    let file = file.to_string_lossy().into_owned();
    let raw = std::fs::read_to_string(&file).unwrap_or_else(|_| "{}".into());
    let Value::Object(mut current) = parse_json(&raw, &file)? else {
        return Err(usage_error(format!("Invalid {file}: Invalid input: expected object")));
    };
    let listed = current.get("plugins").cloned().unwrap_or_else(|| json!([]));
    let Some(listed) = listed.as_array() else {
        let message = format!("Invalid {file} (plugins): Invalid input: expected array");
        return Err(usage_error(message));
    };
    let mut plugins = Vec::new();
    for (at, entry) in listed.iter().enumerate() {
        let Some(known) = entry.get("path").and_then(Value::as_str) else {
            let message = format!("Invalid {file} (plugins.{at}.path): Invalid input");
            return Err(usage_error(message));
        };
        if resolve_path(known) != path {
            plugins.push(entry.clone());
        }
    }
    if add {
        plugins.push(json!({ "path": path, "enabled": true }));
    }
    current.insert("plugins".into(), Value::Array(plugins));
    let next = serde_json::to_string_pretty(&Value::Object(current)).unwrap_or_default();
    std::fs::write(&file, format!("{next}\n")).map_err(|e| CliError::new(e.to_string()))?;
    let result = reload(call, None)?;
    let done = if add { "added to" } else { "removed from" };
    Ok(Output::text(result, format!("{path} {done} {file}; plugins reloaded")))
}

fn plugin_add(call: &mut Call) -> CliResult<Output> {
    let path = resolve_path(call.arg("path")?);
    if !Path::new(&path).join("package.json").exists() {
        return Err(usage_error(format!("{path} has no package.json.")));
    }
    edit_plugin_config(call, true)
}

fn plugin_remove(call: &mut Call) -> CliResult<Output> {
    confirm(call, &format!("Stop loading the plugin at {}?", call.arg("path")?))?;
    edit_plugin_config(call, false)
}

fn server_status(call: &mut Call) -> CliResult<Output> {
    let url = call.env.server_url.clone();
    let config = call.http.get("/server/config", &[]).map_err(|error| {
        CliError::new(format!("No bb server at {url}: {}", error.message))
            .code("server_unreachable")
            .hint("Start it with `bb server`, or set BB_SERVER_URL.")
    })?;
    let data_dir = config["dataDir"].clone();
    let line = format!("bb server at {url} (data in {})", text(&config, "dataDir"));
    let data = json!({
        "running": true,
        "url": url,
        "dataDir": data_dir,
        "primaryHostId": config["primaryHostId"],
    });
    Ok(Output::text(data, line))
}
