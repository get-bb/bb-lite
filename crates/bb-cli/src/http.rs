use std::io::{BufRead, BufReader};
use std::time::Duration;

use serde_json::Value;
use ureq::http::{HeaderValue, Request, Response};
use ureq::middleware::MiddlewareNext;
use ureq::{Agent, Body, SendBody};

use crate::call::{CliError, CliResult};

pub const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 75_000;
pub const THREAD_ID_HEADER: &str = "x-bb-thread-id";
pub const DOOR_HEADER: &str = "x-bb-door";
pub const API_VERSION_HEADER: &str = "x-bb-api";
pub const API_VERSION: &str = "1.8.0";
const BODY_LIMIT: u64 = 1 << 34;

/// Blocking client for `<base>/api/v1`; paths passed to it start with `/` and omit `/api/v1`.
#[derive(Debug, Clone)]
pub struct Http {
    base_url: String,
    timeout_ms: Option<u64>,
    thread_id: Option<String>,
    agent: Agent,
}

fn agent(timeout_ms: Option<u64>, thread_id: Option<&str>) -> Agent {
    let config = Agent::config_builder()
        .timeout_global(timeout_ms.map(Duration::from_millis))
        .http_status_as_error(false);
    let thread = thread_id.and_then(|id| HeaderValue::from_str(id).ok());
    let stamp = move |mut request: Request<SendBody>, next: MiddlewareNext| {
        let headers = request.headers_mut();
        headers.insert(DOOR_HEADER, HeaderValue::from_static("cli"));
        headers.insert(API_VERSION_HEADER, HeaderValue::from_static(API_VERSION));
        if let Some(value) = &thread {
            headers.insert(THREAD_ID_HEADER, value.clone());
        }
        next.handle(request)
    };
    config.middleware(stamp).build().into()
}

pub fn timeout_message(timeout_ms: u64) -> String {
    let duration = if timeout_ms.is_multiple_of(1000) {
        let seconds = timeout_ms / 1000;
        format!("{seconds} {}", if seconds == 1 { "second" } else { "seconds" })
    } else {
        format!("{timeout_ms} ms")
    };
    format!("BB request timed out after {duration}.")
}

fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn extract_error_message(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(collapse(text)).filter(|t| !t.is_empty()),
        Value::Array(items) => items.iter().find_map(extract_error_message),
        Value::Object(record) => {
            let message = record.get("message").filter(|m| m.is_string());
            message.and_then(extract_error_message).or_else(|| {
                ["detail", "error"]
                    .iter()
                    .find_map(|k| record.get(*k).and_then(extract_error_message))
            })
        }
        _ => None,
    }
}

/// The SDK's `describeFailure` + `BbHttpError`: message `HTTP <status>: …`, code from the body or `http_<status>`.
pub fn http_failure(status: u16, status_text: &str, content_type: &str, raw: &str) -> CliError {
    let normalized = collapse(raw);
    let looks_json = content_type.contains("application/json")
        || normalized.starts_with('{')
        || normalized.starts_with('[');
    let (body, code, message) = if normalized.is_empty() {
        (None, None, status_text.to_string())
    } else if !looks_json {
        let message = if !normalized.starts_with('<') {
            normalized
        } else if status_text.is_empty() {
            format!("Request failed with status {status}")
        } else {
            status_text.to_string()
        };
        (None, None, message)
    } else {
        match serde_json::from_str::<Value>(&normalized) {
            Ok(parsed) => {
                let message = extract_error_message(&parsed).unwrap_or(normalized);
                let code = parsed.get("code").and_then(Value::as_str).map(String::from);
                (Some(parsed), code, message)
            }
            Err(_) => (None, None, normalized),
        }
    };
    let code = code.unwrap_or_else(|| format!("http_{status}"));
    let mut error = CliError::new(format!("HTTP {status}: {message}")).code(code);
    error.status = Some(status);
    error.body = body.map(Box::new);
    error
}

impl Http {
    pub fn new(base_url: &str) -> Self {
        Self::with_timeout_ms(base_url, Some(DEFAULT_REQUEST_TIMEOUT_MS))
    }

    pub fn with_timeout_ms(base_url: &str, timeout_ms: Option<u64>) -> Self {
        let base_url = base_url.trim_end_matches('/').to_string();
        Http { base_url, timeout_ms, thread_id: None, agent: agent(timeout_ms, None) }
    }

    /// A copy whose every request names the thread it is sent for (`BB_THREAD_ID`).
    pub fn on_behalf_of(&self, thread_id: Option<&str>) -> Self {
        let agent = agent(self.timeout_ms, thread_id);
        Http { thread_id: thread_id.map(str::to_string), agent, ..self.clone() }
    }

    /// A copy with another request timeout (`None` waits forever), for long polls.
    pub fn timeout(&self, timeout_ms: Option<u64>) -> Self {
        Self::with_timeout_ms(&self.base_url, timeout_ms).on_behalf_of(self.thread_id.as_deref())
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn url(&self, path: &str, query: &[(&str, &str)]) -> String {
        let mut url = format!("{}/api/v1{path}", self.base_url);
        for (at, (name, value)) in query.iter().enumerate() {
            url.push(if at == 0 { '?' } else { '&' });
            url.push_str(&encode(name));
            url.push('=');
            url.push_str(&encode(value));
        }
        url
    }

    fn transport(&self, error: ureq::Error) -> CliError {
        match error {
            ureq::Error::Timeout(_) => CliError::new(timeout_message(self.timeout_ms.unwrap_or(0))),
            ureq::Error::ConnectionFailed => self.unreachable(),
            ureq::Error::Io(io) if io.kind() == std::io::ErrorKind::ConnectionRefused => {
                self.unreachable()
            }
            other => CliError::new(format!("fetch failed: {other}")),
        }
    }

    fn unreachable(&self) -> CliError {
        CliError::new(format!("Cannot reach the bb server at {}.", self.base_url))
            .code("server_unreachable")
            .hint("Start it with `bb server`, or point BB_SERVER_URL at it.")
    }

    /// Sends one request; non-2xx answers become the SDK's HTTP error.
    pub fn send(
        &self,
        method: &str,
        path: &str,
        query: &[(&str, &str)],
        body: Option<&Value>,
    ) -> CliResult<Response<Body>> {
        let url = self.url(path, query);
        let json = body.map(Value::to_string);
        let result = match (method, json) {
            ("GET", _) => self.agent.get(&url).call(),
            ("DELETE", None) => self.agent.delete(&url).call(),
            ("DELETE", Some(json)) => self
                .agent
                .delete(&url)
                .force_send_body()
                .header("content-type", "application/json")
                .send(json),
            (method, json) => {
                let request = match method {
                    "PATCH" => self.agent.patch(&url),
                    "PUT" => self.agent.put(&url),
                    _ => self.agent.post(&url),
                };
                match json {
                    Some(json) => request.header("content-type", "application/json").send(json),
                    None => request.send_empty(),
                }
            }
        };
        self.finish(result)
    }

    fn finish(&self, result: Result<Response<Body>, ureq::Error>) -> CliResult<Response<Body>> {
        let mut response = result.map_err(|error| self.transport(error))?;
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let raw = match response.body_mut().with_config().limit(BODY_LIMIT).read_to_string() {
            Ok(raw) => raw,
            Err(ureq::Error::Timeout(_)) => {
                return Err(CliError::new(timeout_message(self.timeout_ms.unwrap_or(0))));
            }
            Err(_) => String::new(),
        };
        let reason = status.canonical_reason().unwrap_or("");
        Err(http_failure(status.as_u16(), reason, &content_type, &raw))
    }

    pub fn request(
        &self,
        method: &str,
        path: &str,
        query: &[(&str, &str)],
        body: Option<&Value>,
    ) -> CliResult<Value> {
        let response = self.send(method, path, query, body)?;
        self.read_json(response)
    }

    /// POSTs a raw body with its content type, such as a multipart form.
    pub fn post_bytes(&self, path: &str, content_type: &str, bytes: Vec<u8>) -> CliResult<Value> {
        let request = self.agent.post(&self.url(path, &[])).header("content-type", content_type);
        let response = self.finish(request.send(&bytes[..]))?;
        self.read_json(response)
    }

    fn read_json(&self, mut response: Response<Body>) -> CliResult<Value> {
        let text = response
            .body_mut()
            .with_config()
            .limit(BODY_LIMIT)
            .read_to_string()
            .map_err(|error| self.transport(error))?;
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).map_err(|_| CliError::new("The server sent unexpected data."))
    }

    /// POSTs JSON and returns the status and body whatever the status, like a bare `fetch`.
    pub fn post_raw(&self, path: &str, body: &Value) -> CliResult<(u16, String)> {
        let url = self.url(path, &[]);
        let request = self.agent.post(&url).header("content-type", "application/json");
        let mut response = request.send(body.to_string()).map_err(|e| self.transport(e))?;
        let status = response.status().as_u16();
        let text = response.body_mut().with_config().limit(BODY_LIMIT).read_to_string();
        Ok((status, text.map_err(|e| self.transport(e))?))
    }

    pub fn get(&self, path: &str, query: &[(&str, &str)]) -> CliResult<Value> {
        self.request("GET", path, query, None)
    }

    pub fn post(&self, path: &str, body: &Value) -> CliResult<Value> {
        self.request("POST", path, &[], Some(body))
    }

    pub fn patch(&self, path: &str, body: &Value) -> CliResult<Value> {
        self.request("PATCH", path, &[], Some(body))
    }

    pub fn put(&self, path: &str, body: &Value) -> CliResult<Value> {
        self.request("PUT", path, &[], Some(body))
    }

    pub fn delete(&self, path: &str, query: &[(&str, &str)]) -> CliResult<Value> {
        self.request("DELETE", path, query, None)
    }

    /// Reads a streamed answer (NDJSON or SSE) line by line until it ends or `on_line` returns false.
    pub fn stream_lines(
        &self,
        path: &str,
        query: &[(&str, &str)],
        mut on_line: impl FnMut(&str) -> CliResult<bool>,
    ) -> CliResult<()> {
        let response = self.send("GET", path, query, None)?;
        let reader = BufReader::new(response.into_body().into_reader());
        for line in reader.lines() {
            let line = line.map_err(|error| self.transport(ureq::Error::Io(error)))?;
            if !on_line(&line)? {
                break;
            }
        }
        Ok(())
    }
}

/// `encodeURIComponent`, for path segments and query values.
pub fn encode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}
