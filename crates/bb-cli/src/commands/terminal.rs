use std::io::Write;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};

use crate::call::{
    Call, CliError, CliResult, Handler, Output, duration_ms, integer, machine_flag, read_stdin,
    usage_error,
};
use crate::commands::workspace::text;
use crate::http::encode;

const DEFAULT_COLS: u64 = 80;
const DEFAULT_ROWS: u64 = 24;
const INPUT_CHUNK_BYTES: usize = 64 * 1024;
const MATCH_WINDOW_CHARS: usize = 256 * 1024;
const EXIT_TAIL_CHARS: usize = 2000;
const UNMATCHED_EXIT_CODE: i32 = 124;

/// Handlers ported from `apps/cli/src/commands/terminal.ts`.
pub fn handlers() -> Vec<(&'static str, Handler)> {
    vec![
        ("terminalCreate", terminal_create),
        ("terminalList", terminal_list),
        ("terminalOutput", terminal_output),
        ("terminalWait", terminal_wait),
        ("terminalSend", terminal_send),
        ("terminalClose", terminal_close),
    ]
}

enum Scope {
    Thread(String),
    Environment(String),
    HostPath(String, Option<String>),
}

fn list_scope(call: &Call) -> CliResult<Scope> {
    let thread_id = call.id("thread")?;
    let environment_id = call.id("environment")?;
    let host_id = machine_flag(call)?;
    let given = [thread_id.is_some(), environment_id.is_some(), host_id.is_some()];
    let given = given.iter().filter(|g| **g).count();
    if given != 1 {
        let message = "Provide exactly one of --thread, --environment, --machine.";
        let code = if given == 0 { "missing_required" } else { "invalid_value" };
        let mut error = CliError::new(message).code(code);
        if let Some(current) = &call.env.thread_id {
            error = error.hint(format!("For this thread's terminals add --thread {current}."));
        }
        return Err(error);
    }
    Ok(match (thread_id, environment_id, host_id) {
        (Some(thread_id), _, _) => Scope::Thread(thread_id),
        (_, Some(environment_id), _) => Scope::Environment(environment_id),
        (_, _, host_id) => Scope::HostPath(host_id.unwrap_or_default(), call.flag("cwd")?),
    })
}

fn describe_exit(terminal_id: &str, exit_code: &Value) -> String {
    match exit_code {
        Value::Null => format!("Terminal {terminal_id} exited"),
        code => format!("Terminal {terminal_id} exited with code {code}"),
    }
}

fn shell_quote(value: &str) -> String {
    let plain = |c: char| c.is_ascii_alphanumeric() || "_@%+=:,./-".contains(c);
    if !value.is_empty() && value.chars().all(plain) {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn decode(result: &Value) -> Vec<u8> {
    let chunks = result.get("chunks").and_then(Value::as_array);
    let data = chunks.into_iter().flatten().map(|chunk| text(chunk, "dataBase64"));
    data.flat_map(|d| STANDARD.decode(d).unwrap_or_default()).collect()
}

fn output_bounds(call: &Call) -> CliResult<Vec<(&'static str, String)>> {
    let tail = integer(call.flag("tail-bytes")?.as_deref(), "--tail-bytes", 1)?;
    let limit = integer(call.flag("limit-chunks")?.as_deref(), "--limit-chunks", 1)?;
    let pairs = [("tailBytes", tail), ("limitChunks", limit)];
    Ok(pairs.into_iter().filter_map(|(k, v)| v.map(|v| (k, v.to_string()))).collect())
}

fn terminal_path(terminal_id: &str, suffix: &str) -> String {
    format!("/terminals/{}{suffix}", encode(terminal_id))
}

fn output(call: &Call, terminal_id: &str, query: &[(&'static str, String)]) -> CliResult<Value> {
    let query: Vec<(&str, &str)> = query.iter().map(|(k, v)| (*k, v.as_str())).collect();
    call.http.get(&terminal_path(terminal_id, "/output"), &query)
}

fn terminal_create(call: &mut Call) -> CliResult<Output> {
    let typed = call.flag("command")?.map(|c| c.trim().to_string());
    if typed.is_some() && !call.rest().is_empty() {
        return Err(usage_error("Provide --command or positional words, not both."));
    }
    let command = typed.unwrap_or_else(|| {
        call.rest().iter().map(|w| shell_quote(w)).collect::<Vec<_>>().join(" ")
    });
    let target = match list_scope(call)? {
        Scope::Thread(id) => json!({ "kind": "thread", "threadId": id }),
        Scope::Environment(id) => json!({ "kind": "environment", "environmentId": id }),
        Scope::HostPath(id, cwd) => json!({ "kind": "host_path", "hostId": id, "cwd": cwd }),
    };
    let cols = integer(call.flag("cols")?.as_deref(), "--cols", 1)?.unwrap_or(DEFAULT_COLS);
    let rows = integer(call.flag("rows")?.as_deref(), "--rows", 1)?.unwrap_or(DEFAULT_ROWS);
    let start = if command.is_empty() {
        json!({ "mode": "shell" })
    } else {
        json!({ "mode": "command", "command": command })
    };
    let mut body = json!({ "cols": cols, "rows": rows, "start": start, "target": target });
    if let Some(title) = call.flag("title")? {
        body["title"] = json!(title);
    }
    let session = call.http.post("/terminals", &body)?;
    let line = format!("Created terminal {} ({})", text(&session, "id"), text(&session, "title"));
    Ok(Output::text(session, line))
}

fn terminal_list(call: &mut Call) -> CliResult<Output> {
    let query = match list_scope(call)? {
        Scope::Thread(id) => vec![("threadId", id)],
        Scope::Environment(id) => vec![("environmentId", id)],
        Scope::HostPath(id, cwd) => {
            let mut query = vec![("hostId", id)];
            query.extend(cwd.map(|cwd| ("cwd", cwd)));
            query
        }
    };
    let query: Vec<(&str, &str)> = query.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let result = call.http.get("/terminals", &query)?;
    let rows = result.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
    Ok(Output::rows(&rows, &["id", "title", "status", "exitCode"], result))
}

fn terminal_output(call: &mut Call) -> CliResult<Output> {
    let terminal_id = call.arg("terminalId")?.to_string();
    let since = integer(call.flag("since-seq")?.as_deref(), "--since-seq", 0)?;
    let mut query: Vec<(&'static str, String)> =
        since.map(|s| ("sinceSeq", s.to_string())).into_iter().collect();
    query.extend(output_bounds(call)?);
    let result = output(call, &terminal_id, &query)?;
    if call.json() {
        return Ok(Output::json(result));
    }
    let bytes = decode(&result);
    call.stdout
        .write_all(&bytes)
        .and_then(|()| call.stdout.flush())
        .map_err(|e| CliError::new(e.to_string()))?;
    if text(&result, "status") == "exited" {
        eprintln!("{}", describe_exit(&terminal_id, &result["exitCode"]));
    }
    Ok(Output::Done)
}

fn unmatched(message: String, hint: String, code: &str) -> CliError {
    CliError::new(message).code(code).hint(hint).exit_code(UNMATCHED_EXIT_CODE)
}

fn last_chars(text: &str, count: usize) -> &str {
    let skip = text.chars().count().saturating_sub(count);
    text.char_indices().nth(skip).map_or("", |(at, _)| &text[at..])
}

fn terminal_wait(call: &mut Call) -> CliResult<Output> {
    let terminal_id = call.arg("terminalId")?.to_string();
    let contains = call.flag("contains")?;
    let pattern = call.flag("regex")?;
    let until_exit = call.on("exit")?;
    let targets = [contains.is_some(), pattern.is_some(), until_exit];
    if targets.iter().filter(|t| **t).count() != 1 {
        let hint = format!("For example: bb terminal wait {terminal_id} --exit");
        let message = "Provide exactly one of --contains, --regex or --exit.";
        return Err(CliError::new(message).code("missing_required").hint(hint));
    }
    let timeout = duration_ms(
        &call.flag("timeout")?.unwrap_or_else(|| "30".into()),
        "--timeout",
        "s",
        false,
    )?;
    let interval = call.flag("poll-interval")?.unwrap_or_else(|| "500".into());
    let poll_ms = duration_ms(&interval, "--poll-interval", "ms", false)?;
    let regex = match &pattern {
        None => None,
        Some(p) => Some(
            regex::Regex::new(p)
                .map_err(|e| CliError::new(format!("Invalid regular expression: /{p}/u: {e}")))?,
        ),
    };
    let bounds = output_bounds(call)?;
    let deadline = Instant::now() + Duration::from_millis(timeout);
    let done = |matched: &str, next_seq: Value, exit_code: Value| {
        let line = if matched == "exit" {
            describe_exit(&terminal_id, &exit_code)
        } else {
            format!("Terminal {terminal_id} matched {matched}")
        };
        let data = json!({ "terminalId": terminal_id, "matched": matched, "nextSeq": next_seq, "exitCode": exit_code });
        Ok(Output::text(data, line))
    };
    let mut next_seq = if call.on("from-start")? { Some(Value::from(0)) } else { None };
    if !until_exit && next_seq.is_none() {
        let tail = [("limitChunks", "1".to_string()), ("tailBytes", "1".to_string())];
        let current = output(call, &terminal_id, &tail)?;
        if text(&current, "status") == "exited" {
            let exited = describe_exit(&terminal_id, &current["exitCode"]);
            let hint = "Match its existing output with --from-start.".to_string();
            return Err(unmatched(format!("{exited} before this wait."), hint, "terminal_exited"));
        }
        next_seq = Some(current["nextSeq"].clone());
    }
    let mut seen = String::new();
    while Instant::now() <= deadline {
        if until_exit {
            let session = call.http.get(&terminal_path(&terminal_id, ""), &[])?;
            if text(&session, "status") == "exited" {
                return done("exit", json!(0), session["exitCode"].clone());
            }
        } else {
            let mut page = bounds.clone();
            if let Some(seq) = next_seq.as_ref().filter(|s| !s.is_null()) {
                page.push(("sinceSeq", seq.to_string()));
            }
            let result = output(call, &terminal_id, &page)?;
            next_seq = Some(result["nextSeq"].clone());
            let searched = seen.clone() + &String::from_utf8_lossy(&decode(&result));
            seen = last_chars(&searched, MATCH_WINDOW_CHARS).to_string();
            let found = regex.as_ref().filter(|r| r.is_match(&searched)).and(pattern.clone());
            let matched = contains.clone().filter(|c| searched.contains(c.as_str())).or(found);
            let seq = next_seq.clone().unwrap_or(Value::Null);
            if let Some(matched) = matched {
                return done(&matched, seq, result["exitCode"].clone());
            }
            if text(&result, "status") == "exited" {
                let tail = last_chars(&seen, EXIT_TAIL_CHARS).trim_end();
                let exited = describe_exit(&terminal_id, &result["exitCode"]);
                let hint = if tail.is_empty() {
                    "It printed nothing.".to_string()
                } else {
                    format!("Last output:\n{tail}")
                };
                let message = format!("{exited} before the output matched.");
                return Err(unmatched(message, hint, "terminal_exited"));
            }
        }
        std::thread::sleep(Duration::from_millis(poll_ms));
    }
    let hint = format!("Read it with `bb terminal output {terminal_id}`.");
    let message = format!("Timed out waiting for terminal {terminal_id}");
    Err(unmatched(message, hint, "timeout"))
}

fn terminal_send(call: &mut Call) -> CliResult<Output> {
    let terminal_id = call.arg("terminalId")?.to_string();
    let text_flag = call.flag("text")?;
    if text_flag.is_none() != call.on("stdin")? {
        return Err(usage_error("Provide exactly one of --text or --stdin."));
    }
    let mut data = match text_flag {
        Some(text) => text.into_bytes(),
        None => read_stdin()?,
    };
    if call.on("enter")? {
        data.push(b'\n');
    }
    if data.is_empty() {
        return Err(usage_error("Terminal input cannot be empty."));
    }
    let mut session = Value::Null;
    for part in data.chunks(INPUT_CHUNK_BYTES) {
        let body = json!({ "dataBase64": STANDARD.encode(part) });
        session = call.http.post(&terminal_path(&terminal_id, "/input"), &body)?;
    }
    Ok(Output::text(session, format!("Sent input to terminal {terminal_id}")))
}

fn terminal_close(call: &mut Call) -> CliResult<Output> {
    let terminal_id = call.arg("terminalId")?.to_string();
    let mode = if call.on("if-clean")? { "if-clean" } else { "force" };
    let body = json!({ "mode": mode, "reason": "user" });
    let session = call.http.post(&terminal_path(&terminal_id, "/close"), &body)?;
    Ok(Output::text(session, format!("Closed terminal {terminal_id}")))
}
