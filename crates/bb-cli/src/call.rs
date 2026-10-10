use std::io::{IsTerminal, Read, Write};

use serde_json::Value;

use crate::engine::{CommandSpec, Invocation, Table};
use crate::http::Http;

pub const DEFAULT_SERVER_URL: &str = "http://127.0.0.1:48886";
const CELL_WIDTH: usize = 60;

pub type CliResult<T> = Result<T, CliError>;

/// A command handler: `thread section list` is registered as `threadSectionList`.
pub type Handler = fn(&mut Call<'_>) -> CliResult<Output>;

#[derive(Debug, Clone, PartialEq)]
pub struct CliError {
    pub message: String,
    pub code: String,
    pub hint: Option<String>,
    pub exit_code: i32,
    pub status: Option<u16>,
    pub body: Option<Box<Value>>,
}

impl CliError {
    pub fn new(message: impl Into<String>) -> Self {
        let message = message.into();
        CliError {
            message,
            code: "error".into(),
            hint: None,
            exit_code: 1,
            status: None,
            body: None,
        }
    }

    pub fn code(mut self, code: impl Into<String>) -> Self {
        self.code = code.into();
        self
    }

    pub fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    pub fn exit_code(mut self, exit_code: i32) -> Self {
        self.exit_code = exit_code;
        self
    }
}

impl std::fmt::Display for CliError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CliError {}

pub fn usage_error(message: impl Into<String>) -> CliError {
    CliError::new(message).code("invalid_value")
}

/// What a handler returns; the engine prints `data` as JSON with `--json` or when `text` is `None`.
#[derive(Debug, Clone, PartialEq)]
pub enum Output {
    Done,
    Data { data: Value, text: Option<String> },
}

impl Output {
    pub fn json(data: Value) -> Self {
        Output::Data { data, text: None }
    }

    pub fn text(data: Value, text: impl Into<String>) -> Self {
        Output::Data { data, text: Some(text.into()) }
    }

    pub fn lines(data: Value, lines: &[String]) -> Self {
        Output::text(data, lines.join("\n"))
    }

    /// `call.rows`: a table of `keys` (`…At` numbers shown as local dates), or `None found`.
    pub fn rows(rows: &[Value], keys: &[&str], data: Value) -> Self {
        let shown = |key: &str, value: Option<&Value>| match value {
            Some(Value::Number(n)) if key.ends_with("At") => locale_date(n.as_f64().unwrap_or(0.0)),
            Some(Value::String(text)) => clip(text, CELL_WIDTH),
            None | Some(Value::Null) => "-".into(),
            Some(other) => clip(&js_string(other), CELL_WIDTH),
        };
        let cells: Vec<Vec<String>> =
            rows.iter().map(|row| keys.iter().map(|k| shown(k, row.get(*k))).collect()).collect();
        let len = |text: &str| text.encode_utf16().count();
        let widths: Vec<usize> = keys
            .iter()
            .enumerate()
            .map(|(column, key)| {
                cells.iter().map(|row| len(&row[column])).fold(len(key), usize::max)
            })
            .collect();
        let line = |row: &[String]| {
            let padded: Vec<String> = row
                .iter()
                .zip(&widths)
                .map(|(cell, width)| format!("{cell}{}", " ".repeat(width - len(cell))))
                .collect();
            padded.join("  ").trim_end().to_string()
        };
        if rows.is_empty() {
            return Output::text(data, "None found");
        }
        let head: Vec<String> = keys.iter().map(|k| k.to_uppercase()).collect();
        let mut lines = vec![String::new(), line(&head)];
        lines.extend(cells.iter().map(|row| line(row)));
        lines.push(String::new());
        Output::lines(data, &lines)
    }
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CliEnv {
    pub server_url: String,
    pub thread_id: Option<String>,
    pub project_id: Option<String>,
    pub environment_id: Option<String>,
    pub host_id: Option<String>,
    pub thread_storage: Option<String>,
}

pub fn valid_id(value: &str, source: &str) -> CliResult<String> {
    let ok = !value.is_empty()
        && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if ok {
        return Ok(value.to_string());
    }
    Err(usage_error(format!(
        "Invalid ID from {source}: \"{value}\". IDs contain only letters, digits, hyphens and \
         underscores."
    )))
}

pub fn read_env(var: impl Fn(&str) -> Option<String>) -> CliResult<CliEnv> {
    let trimmed = |name: &str| var(name).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    let id = |name: &str| trimmed(name).map(|v| valid_id(&v, name)).transpose();
    let server_url = trimmed("BB_SERVER_URL").unwrap_or_else(|| DEFAULT_SERVER_URL.into());
    Ok(CliEnv {
        server_url: server_url.trim_end_matches('/').to_string(),
        thread_id: id("BB_THREAD_ID")?,
        project_id: id("BB_PROJECT_ID")?,
        environment_id: id("BB_ENVIRONMENT_ID")?,
        host_id: id("BB_HOST_ID")?,
        thread_storage: trimmed("BB_THREAD_STORAGE"),
    })
}

pub fn clip(value: &str, width: usize) -> String {
    let line = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let units: Vec<u16> = line.encode_utf16().collect();
    if units.len() <= width {
        return line;
    }
    format!("{}…", String::from_utf16_lossy(&units[..width - 1]))
}

/// `new Date(ms).toLocaleString()` in the en-US locale and the local time zone.
pub fn locale_date(ms: f64) -> String {
    let seconds = (ms / 1000.0).floor() as libc::time_t;
    // SAFETY: localtime_r writes only into the zeroed tm we pass it.
    let tm = unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&seconds, &mut tm);
        tm
    };
    let hour = match tm.tm_hour % 12 {
        0 => 12,
        h => h,
    };
    let half = if tm.tm_hour < 12 { "AM" } else { "PM" };
    format!(
        "{}/{}/{}, {hour}:{:02}:{:02} {half}",
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_year + 1900,
        tm.tm_min,
        tm.tm_sec
    )
}

pub fn iso_date(ms: f64) -> String {
    let seconds = (ms / 1000.0).floor() as libc::time_t;
    // SAFETY: gmtime_r writes only into the zeroed tm we pass it.
    let tm = unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        libc::gmtime_r(&seconds, &mut tm);
        tm
    };
    format!(
        "{}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec,
        ms.rem_euclid(1000.0) as u32
    )
}

pub struct Call<'a> {
    pub table: &'a Table,
    pub spec: &'a CommandSpec,
    pub invocation: Invocation,
    pub env: CliEnv,
    pub http: Http,
    pub stdout: Box<dyn Write + 'a>,
    pub wrote_json: bool,
    /// The whole command line after `bb`, for commands handed to the Node CLI.
    pub argv: Vec<String>,
}

impl<'a> Call<'a> {
    pub fn new(
        table: &'a Table,
        spec: &'a CommandSpec,
        invocation: Invocation,
        env: CliEnv,
    ) -> Self {
        let http = Http::new(&env.server_url).on_behalf_of(env.thread_id.as_deref());
        let stdout = Box::new(std::io::stdout());
        Call { table, spec, invocation, env, http, stdout, wrote_json: false, argv: Vec::new() }
    }

    /// An optional or required positional argument by its name in the table (`<id>` → `id`).
    pub fn args(&self, name: &str) -> Option<&str> {
        self.invocation.args.get(name).map(String::as_str)
    }

    pub fn arg(&self, name: &str) -> CliResult<&str> {
        self.args(name).ok_or_else(|| {
            CliError::new(format!("'bb {}' has no required <{name}>", self.spec.path))
        })
    }

    pub fn rest(&self) -> &[String] {
        &self.invocation.rest
    }

    pub fn list(&self, name: &str) -> CliResult<Vec<String>> {
        if !self.spec.flags.iter().any(|f| f.names.first().is_some_and(|n| n == name)) {
            let path = &self.spec.path;
            return Err(CliError::new(format!("'bb {path}' does not declare --{name}")));
        }
        Ok(self.invocation.flags.get(name).cloned().unwrap_or_default())
    }

    pub fn flag(&self, name: &str) -> CliResult<Option<String>> {
        Ok(self.list(name)?.pop())
    }

    pub fn on(&self, name: &str) -> CliResult<bool> {
        self.list(name)?;
        Ok(self.invocation.flags.contains_key(name))
    }

    pub fn json(&self) -> bool {
        self.invocation.flags.contains_key("json")
    }

    pub fn id(&self, name: &str) -> CliResult<Option<String>> {
        let value = self.flag(name)?.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        value.map(|v| valid_id(&v, &format!("--{name}"))).transpose()
    }

    pub fn choice(&self, name: &str, allowed: &[&'static str]) -> CliResult<Option<&'static str>> {
        let Some(value) = self.flag(name)?.map(|v| v.trim().to_lowercase()) else {
            return Ok(None);
        };
        if let Some(found) = allowed.iter().find(|c| **c == value) {
            return Ok(Some(found));
        }
        let expected = allowed.join(", ");
        Err(usage_error(format!("Invalid --{name} '{value}'. Expected: {expected}.")))
    }

    /// Writes one line to stdout now, for handlers that stream.
    pub fn print(&mut self, text: &str) -> CliResult<()> {
        writeln!(self.stdout, "{text}").map_err(|e| CliError::new(e.to_string()))
    }

    pub fn emit(&mut self, output: Output) -> CliResult<()> {
        let Output::Data { data, text } = output else { return Ok(()) };
        match text {
            Some(text) if !self.json() => self.print(&text),
            _ => {
                self.wrote_json = true;
                let pretty = serde_json::to_string_pretty(&data).unwrap_or_default();
                self.print(&pretty)
            }
        }
    }
}

pub fn thread_target(call: &Call) -> CliResult<String> {
    let id = call.args("id");
    let current = call.env.thread_id.clone();
    if call.on("self")? {
        if id.is_some() {
            return Err(usage_error("Cannot combine a thread ID argument with --self."));
        }
        return current.ok_or_else(|| usage_error("--self requires BB_THREAD_ID to be set."));
    }
    if let Some(id) = id {
        return valid_id(id, "<id> argument");
    }
    let mut error =
        CliError::new("Missing thread ID. Pass <id> or use --self.").code("missing_required");
    error.hint = current.map(|c| format!("Add --self to target the current thread ({c})."));
    Err(error)
}

pub fn confirm(call: &Call, question: &str) -> CliResult<()> {
    if call.on("yes")? {
        return Ok(());
    }
    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        let message = "Refusing a destructive action without an interactive terminal.";
        return Err(usage_error(message).hint("Re-run with --yes to confirm."));
    }
    print!("{question} [y/N] ");
    let _ = std::io::stdout().flush();
    let mut answer = String::new();
    let _ = std::io::stdin().read_line(&mut answer);
    if ["y", "yes"].contains(&answer.trim().to_lowercase().as_str()) {
        return Ok(());
    }
    Err(CliError::new("Cancelled.").code("cancelled"))
}

pub fn read_stdin() -> CliResult<Vec<u8>> {
    let mut input = Vec::new();
    std::io::stdin().read_to_end(&mut input).map_err(|e| CliError::new(e.to_string()))?;
    Ok(input)
}

pub fn text_input(
    call: &Call,
    inline: Option<&str>,
    file_flag: &str,
    label: &str,
) -> CliResult<String> {
    let Some(file) = call.flag(file_flag)? else {
        return inline.map(String::from).ok_or_else(|| {
            CliError::new(format!("Missing {label}."))
                .code("missing_required")
                .hint(format!("Pass {label}, or --{file_flag} <path> (- reads stdin)."))
        });
    };
    if inline.is_some() {
        return Err(usage_error(format!("Provide only one of {label} or --{file_flag}.")));
    }
    if file == "-" && std::io::stdin().is_terminal() {
        return Err(usage_error(format!("--{file_flag} - reads stdin, but stdin is a terminal.")));
    }
    let raw = if file == "-" {
        String::from_utf8_lossy(&read_stdin()?).into_owned()
    } else {
        std::fs::read_to_string(&file)
            .map_err(|e| usage_error(format!("Could not read --{file_flag}: {e}")))?
    };
    let text = raw.trim_end_matches(['\r', '\n']).to_string();
    if !text.trim().is_empty() {
        return Ok(text);
    }
    let source = if file == "-" { "stdin" } else { &file };
    Err(usage_error(format!("--{file_flag} {source} is empty.")))
}

fn unit_ms(unit: &str) -> Option<f64> {
    let ms = match unit {
        "ms" => 1.0,
        "s" => 1000.0,
        "m" => 60_000.0,
        "h" => 3_600_000.0,
        "d" => 86_400_000.0,
        _ => return None,
    };
    Some(ms)
}

fn split_duration(value: &str) -> Option<(f64, &str)> {
    let digits = value.find(|c: char| !c.is_ascii_digit() && c != '.').unwrap_or(value.len());
    let (amount, suffix) = value.split_at(digits);
    let shape = amount.split('.').collect::<Vec<_>>();
    let numeric = shape.iter().all(|p| !p.is_empty()) && shape.len() <= 2;
    let unit = suffix.is_empty() || unit_ms(suffix).is_some();
    (numeric && unit).then(|| amount.parse().ok().map(|n| (n, suffix))).flatten()
}

/// `durationMs`: a number of `unit`s or a duration with a unit (500ms, 90s, 20m, 4h).
pub fn duration_ms(value: &str, label: &str, unit: &str, allow_zero: bool) -> CliResult<u64> {
    let lowered = value.trim().to_lowercase();
    let Some((amount, suffix)) = split_duration(&lowered) else {
        return Err(usage_error(format!(
            "Invalid {label} '{value}'. Expected a number of {unit} or a duration with a unit \
             (500ms, 90s, 20m, 4h)."
        )));
    };
    let scale = unit_ms(suffix).or_else(|| unit_ms(unit)).unwrap_or(1.0);
    let ms = (amount * scale).round() as u64;
    if ms > 0 || allow_zero {
        return Ok(ms);
    }
    Err(usage_error(format!("{label} must be greater than zero.")))
}

pub fn integer(value: Option<&str>, label: &str, minimum: u64) -> CliResult<Option<u64>> {
    let Some(value) = value else { return Ok(None) };
    let parsed = value.bytes().all(|b| b.is_ascii_digit()).then(|| value.parse::<u64>().ok());
    match parsed.flatten() {
        Some(n) if n >= minimum => Ok(Some(n)),
        _ => Err(usage_error(format!("{label} must be an integer of at least {minimum}."))),
    }
}

pub fn parse_json(value: &str, label: &str) -> CliResult<Value> {
    serde_json::from_str(value).map_err(|_| usage_error(format!("{label} must be valid JSON.")))
}

pub fn machine_id(call: &Call, target: &str) -> CliResult<String> {
    let wanted = target.trim();
    if wanted.starts_with("host_") {
        return valid_id(wanted, "machine ID");
    }
    let hosts = call.http.get("/machines", &[("includeCreating", "true")])?;
    let hosts = hosts.as_array().cloned().unwrap_or_default();
    let field =
        |host: &Value, key: &str| host.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    let named: Vec<&Value> = hosts.iter().filter(|h| field(h, "name") == wanted).collect();
    if let [found] = named.as_slice() {
        return Ok(field(found, "id"));
    }
    let all: Vec<String> =
        hosts.iter().map(|h| format!("{} ({})", field(h, "name"), field(h, "id"))).collect();
    let problem = if named.is_empty() { "was not found" } else { "is ambiguous" };
    Err(usage_error(format!("Machine '{wanted}' {problem}. Machines: {}.", all.join(", "))))
}

pub fn machine_flag(call: &Call) -> CliResult<Option<String>> {
    call.flag("machine")?.map(|machine| machine_id(call, &machine)).transpose()
}

pub fn this_machine_id(call: &Call) -> CliResult<String> {
    let text = |value: &Value, key: &str| value.get(key).and_then(Value::as_str).map(String::from);
    if let Some(environment_id) = &call.env.environment_id {
        let environment = call.http.get(&format!("/environments/{environment_id}"), &[])?;
        return Ok(text(&environment, "hostId").unwrap_or_default());
    }
    let config = call.http.get("/server/config", &[])?;
    text(&config, "primaryHostId")
        .ok_or_else(|| usage_error("The server has no machine of its own.").hint("Pass --machine."))
}

pub fn machine_or_this(call: &Call) -> CliResult<String> {
    match machine_flag(call)? {
        Some(id) => Ok(id),
        None => this_machine_id(call),
    }
}

pub fn option_assignment(raw: &str) -> CliResult<(String, String)> {
    match raw.find('=') {
        Some(separator) if separator > 0 => {
            Ok((raw[..separator].to_string(), raw[separator + 1..].to_string()))
        }
        _ => Err(usage_error(format!("Expected id=value, got \"{raw}\"."))),
    }
}

pub fn not_implemented(call: &mut Call) -> CliResult<Output> {
    let path = &call.spec.path;
    let message = format!("'bb {path}' is not implemented in the Rust CLI yet.");
    Err(CliError::new(message).code("not_implemented"))
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn number(text: &str, from: usize, to: usize) -> Option<i64> {
    let part = text.get(from..to)?;
    part.bytes().all(|b| b.is_ascii_digit()).then(|| part.parse().ok()).flatten()
}

/// `Date.parse` of the `TIMESTAMP` shapes: local time unless a zone is given.
pub fn timestamp_ms(text: &str) -> Option<f64> {
    let bytes = text.as_bytes();
    let separators = [(4, b'-'), (7, b'-'), (13, b':')];
    if bytes.len() < 16 || separators.iter().any(|&(at, byte)| bytes[at] != byte) {
        return None;
    }
    if bytes[10] != b'T' && bytes[10] != b' ' {
        return None;
    }
    let (year, month, day) = (number(text, 0, 4)?, number(text, 5, 7)?, number(text, 8, 10)?);
    let (hour, minute) = (number(text, 11, 13)?, number(text, 14, 16)?);
    let mut rest = &text[16..];
    let mut second = 0;
    let mut millis = 0.0;
    if let Some(tail) = rest.strip_prefix(':') {
        second = number(tail, 0, 2)?;
        rest = &tail[2..];
        if let Some(fraction) = rest.strip_prefix('.') {
            let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
            if !(1..=3).contains(&digits) {
                return None;
            }
            millis = format!("0.{}", &fraction[..digits]).parse::<f64>().ok()? * 1000.0;
            rest = &fraction[digits..];
        }
    }
    let valid = (1..=12).contains(&month)
        && (1..=31).contains(&day)
        && (hour < 24 || (hour == 24 && minute == 0 && second == 0 && millis == 0.0))
        && minute < 60
        && second < 60;
    if !valid {
        return None;
    }
    let offset_minutes = match rest {
        "" => None,
        "Z" => Some(0),
        zone => {
            let sign = match zone.as_bytes()[0] {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let digits = zone[1..].replacen(':', "", usize::from(zone.len() == 6));
            if digits.len() != 4 {
                return None;
            }
            let (hours, minutes) = (number(&digits, 0, 2)?, number(&digits, 2, 4)?);
            Some(sign * (hours * 60 + minutes))
        }
    };
    let seconds = match offset_minutes {
        Some(offset) => {
            let days = days_from_civil(year, month, day);
            days * 86_400 + hour * 3600 + minute * 60 + second - offset * 60
        }
        // SAFETY: mktime reads and normalises only the zeroed tm we pass it.
        None => unsafe {
            let mut tm: libc::tm = std::mem::zeroed();
            tm.tm_year = (year - 1900) as libc::c_int;
            tm.tm_mon = (month - 1) as libc::c_int;
            tm.tm_mday = day as libc::c_int;
            tm.tm_hour = hour as libc::c_int;
            tm.tm_min = minute as libc::c_int;
            tm.tm_sec = second as libc::c_int;
            tm.tm_isdst = -1;
            libc::mktime(&mut tm)
        },
    };
    Some(seconds as f64 * 1000.0 + millis)
}

/// `sendAtMs`: a future timestamp or a duration from `now`, in epoch milliseconds.
pub fn send_at_ms(value: Option<&str>, now: f64) -> CliResult<Option<f64>> {
    let Some(value) = value else { return Ok(None) };
    let trimmed = value.trim();
    let relative = split_duration(trimmed).is_some_and(|(_, suffix)| !suffix.is_empty());
    let at = if relative {
        Some(now + duration_ms(trimmed, "--send-at", "s", false)? as f64)
    } else {
        timestamp_ms(trimmed)
    };
    match at {
        Some(at) if at > now => Ok(Some(at)),
        _ => Err(usage_error(format!(
            "Invalid --send-at '{value}'. Expected a future ISO 8601 timestamp (2026-08-25T09:00) \
             or a duration from now (30s, 10m, 2h, 7d)."
        ))),
    }
}

pub fn now_ms() -> f64 {
    let elapsed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH);
    elapsed.map(|d| d.as_millis() as f64).unwrap_or(0.0)
}
