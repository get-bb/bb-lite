use std::io::{IsTerminal, Write};

use serde_json::{Value, json};

use crate::call::{CliEnv, CliResult, read_stdin, usage_error};
use crate::http::Http;

const STDIN_MAX_BYTES: usize = 16 * 1024;

fn stdin_flag(token: &str) -> bool {
    let Some(name) = token.strip_prefix("--").and_then(|t| t.strip_suffix("-stdin")) else {
        return false;
    };
    let allowed = name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    allowed && !name.starts_with('-') && !name.ends_with('-') && !name.is_empty()
}

fn materialize_stdin_flag(argv: Vec<String>) -> CliResult<Vec<String>> {
    let end = argv.iter().position(|t| t == "--").unwrap_or(argv.len());
    let scanned = &argv[..end];
    let found: Vec<&String> = scanned.iter().filter(|t| stdin_flag(t)).collect();
    let Some(flag) = found.first().map(|f| f.to_string()) else { return Ok(argv) };
    let value_flag = flag[..flag.len() - "-stdin".len()].to_string();
    if found.len() > 1 || scanned.contains(&value_flag) {
        return Err(usage_error(format!("Choose only one of {flag} and {value_flag}.")));
    }
    if std::io::stdin().is_terminal() {
        return Err(usage_error(format!("{flag} requires piped stdin.")));
    }
    let input = read_stdin()?;
    let text = String::from_utf8_lossy(&input);
    let value = text.strip_suffix('\n').map(|t| t.strip_suffix('\r').unwrap_or(t)).unwrap_or(&text);
    let one_line = !value.is_empty() && !value.contains(['\r', '\n']);
    if !one_line || input.len() > STDIN_MAX_BYTES {
        let message = format!("{flag} needs one non-empty stdin line of at most 16 KiB.");
        return Err(usage_error(message));
    }
    let at = argv.iter().position(|t| *t == flag).unwrap_or(0);
    let mut out = argv[..at].to_vec();
    out.extend([value_flag, value.to_string()]);
    out.extend(argv[at + 1..].iter().cloned());
    Ok(out)
}

pub fn find_plugin_command(env: &CliEnv, name: &str) -> CliResult<Option<String>> {
    let http = Http::new(&env.server_url).on_behalf_of(env.thread_id.as_deref());
    let contributions = http.get("/plugins/contributions", &[])?;
    let commands = contributions.get("cliCommands").and_then(Value::as_array);
    let found = commands
        .into_iter()
        .flatten()
        .find(|c| c.get("name").and_then(Value::as_str) == Some(name));
    Ok(found.and_then(|c| c.get("pluginId")).and_then(Value::as_str).map(String::from))
}

pub fn find_plugin_spelling(env: &CliEnv, spelling: &str) -> CliResult<Option<String>> {
    let http = Http::new(&env.server_url).on_behalf_of(env.thread_id.as_deref());
    let contributions = http.get("/plugins/contributions", &[])?;
    let plugins = contributions.get("cliCommands").and_then(Value::as_array);
    let found = plugins.into_iter().flatten().find(|plugin| {
        let commands = plugin.get("commands").and_then(Value::as_array);
        let named = |c: &Value| c.get("name").and_then(Value::as_str) == Some(spelling);
        commands.is_some_and(|list| list.iter().any(named))
    });
    Ok(found.and_then(|c| c.get("pluginId")).and_then(Value::as_str).map(String::from))
}

pub fn run_plugin_command(env: &CliEnv, plugin_id: &str, args: Vec<String>) -> CliResult<i32> {
    let argv = materialize_stdin_flag(args)?;
    let cwd = std::env::current_dir().map(|d| d.display().to_string()).unwrap_or_default();
    let mut body = json!({ "argv": argv, "cwd": cwd });
    if let Some(id) = &env.thread_id {
        body["threadId"] = json!(id);
    }
    if let Some(id) = &env.project_id {
        body["projectId"] = json!(id);
    }
    if let Some(id) = &env.host_id {
        body["hostId"] = json!(id);
    }
    let http = Http::with_timeout_ms(&env.server_url, None).on_behalf_of(env.thread_id.as_deref());
    let (status, text) = http.post_raw(&format!("/plugins/{plugin_id}/cli"), &body)?;
    let trimmed = text.trim();
    let parsed: Value = serde_json::from_str(if trimmed.is_empty() { "null" } else { trimmed })
        .map_err(|e| crate::call::CliError::new(e.to_string()))?;
    let field = |key: &str| parsed.get(key).and_then(Value::as_str);
    let (Some(stdout), Some(stderr), Some(code)) =
        (field("stdout"), field("stderr"), parsed.get("exitCode").and_then(Value::as_f64))
    else {
        let message = format!("The plugin command endpoint answered HTTP {status}");
        return Err(crate::call::CliError::new(message));
    };
    let line = |text: &str| {
        if text.is_empty() || text.ends_with('\n') { text.to_string() } else { format!("{text}\n") }
    };
    let _ = std::io::stdout().write_all(line(stdout).as_bytes());
    let _ = std::io::stderr().write_all(line(stderr).as_bytes());
    Ok(code as i32)
}
