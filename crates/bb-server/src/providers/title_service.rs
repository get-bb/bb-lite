use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use base64::Engine;
use base64::engine::DecodePaddingMode;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use regex::Regex;
use serde::Deserialize;
use serde_json::{Value, json};

const MODELS: [&str; 2] = ["gpt-6-luna", "gpt-5.6-luna"];
const BUDGET: Duration = Duration::from_millis(5_000);
const MAX_TITLE_COLUMNS: usize = 48;
const INSTRUCTIONS: &str =
    "Follow the user prompt. Reply with only the requested text, without quotes or commentary.";
const TITLE_PROMPT: &str = "You create concise titles for coding tasks.
Reply with only the title: short, clear, sentence case, in the same language \
as the task. Keep it under about 40 characters; for scripts that do not \
separate words with spaces, that is roughly 20 characters. Summarize the task \
in your own words instead of copying its text. No quotes, no trailing \
punctuation, no explanation.

Consider the user's intent when titling to make it useful. For instance, if \
they detail specific tools to use to solve a problem, it is the problem that \
should be the title, not the tools that should be used.

Task:
";

static THINK_BLOCK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)<think(?:ing)?>[\s\S]*?(?:</think(?:ing)?>|\z)").expect("valid regex")
});
static LABEL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(?:title|thread title)\s*:\s*").expect("valid regex"));
static BULLET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[-*]\s+").expect("valid regex"));
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").expect("valid regex"));
static LINE_BREAK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\r?\n").expect("valid regex"));
static SKIPPED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^$|^```|:$").expect("valid regex"));
const BASE64URL: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::URL_SAFE,
    GeneralPurposeConfig::new()
        .with_decode_padding_mode(DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true),
);

/// The two Codex responses endpoints: ChatGPT logins and API keys.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TitleEndpoints {
    pub chatgpt: String,
    pub api_key: String,
}

impl Default for TitleEndpoints {
    fn default() -> Self {
        Self {
            chatgpt: "https://chatgpt.com/backend-api/codex/responses".to_string(),
            api_key: "https://api.openai.com/v1/responses".to_string(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TitleHttpRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TitleHttpResponse {
    pub status: u16,
    pub body: String,
}

#[derive(Debug, thiserror::Error)]
pub enum TitleError {
    #[error("Codex title: HTTP {0}")]
    Status(u16),
    #[error("{0}")]
    Request(String),
    #[error("The operation was aborted due to timeout")]
    Timeout,
}

/// POSTs a title request. The real implementation is [`ReqwestTitleClient`], which only
/// `start` constructs; tests use a fake.
#[async_trait]
pub trait TitleHttpClient: Send + Sync {
    async fn post(&self, request: TitleHttpRequest) -> Result<TitleHttpResponse, TitleError>;
}

#[derive(Clone, Debug, Default)]
pub struct ReqwestTitleClient {
    client: reqwest::Client,
}

impl ReqwestTitleClient {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl TitleHttpClient for ReqwestTitleClient {
    async fn post(&self, request: TitleHttpRequest) -> Result<TitleHttpResponse, TitleError> {
        let mut builder = self.client.post(&request.url).body(request.body);
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        let failed = |error: reqwest::Error| TitleError::Request(error.to_string());
        let response = builder.send().await.map_err(failed)?;
        let status = response.status().as_u16();
        let body = response.text().await.map_err(failed)?;
        Ok(TitleHttpResponse { status, body })
    }
}

#[derive(Deserialize)]
struct AuthTokens {
    access_token: String,
    account_id: String,
}

#[derive(Deserialize)]
struct AuthFile {
    #[serde(default)]
    auth_mode: Option<String>,
    #[serde(default, rename = "OPENAI_API_KEY")]
    openai_api_key: Option<String>,
    #[serde(default)]
    tokens: Option<AuthTokens>,
}

struct Target {
    url: String,
    token: String,
    extra: Vec<(String, String)>,
}

/// `$CODEX_HOME` (trimmed, when not blank) or `~/.codex`.
pub fn codex_home(codex_home_env: Option<&str>) -> PathBuf {
    match codex_home_env.map(str::trim) {
        Some(home) if !home.is_empty() => PathBuf::from(home),
        _ => std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default().join(".codex"),
    }
}

fn token_expiry(token: &str) -> Option<f64> {
    let payload = token.split('.').nth(1).unwrap_or("");
    let decoded = BASE64URL.decode(payload).ok()?;
    let claims: Value = serde_json::from_slice(&decoded).ok()?;
    let exp = claims.as_object()?.get("exp")?;
    exp.as_f64()
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as f64)
        .unwrap_or(0.0)
}

async fn credential(urls: &TitleEndpoints, home: &Path) -> Option<Target> {
    let file = tokio::fs::read_to_string(home.join("auth.json")).await.ok()?;
    let auth = serde_json::from_str::<AuthFile>(&file).ok();
    let api_key =
        auth.as_ref().and_then(|auth| auth.openai_api_key.clone()).filter(|key| !key.is_empty());
    let mode = auth
        .as_ref()
        .and_then(|auth| auth.auth_mode.as_deref())
        .map_or_else(|| "apikey".to_string(), str::to_lowercase);
    if let Some(token) = api_key
        && mode == "apikey"
    {
        return Some(Target { url: urls.api_key.clone(), token, extra: Vec::new() });
    }
    let AuthTokens { access_token, account_id } = auth?.tokens?;
    let expiry = token_expiry(&access_token).unwrap_or(f64::INFINITY);
    if now_ms() >= expiry * 1000.0 {
        return None;
    }
    let extra = vec![
        ("chatgpt-account-id".to_string(), account_id),
        ("originator".to_string(), "bb".to_string()),
        ("OpenAI-Beta".to_string(), "responses=experimental".to_string()),
    ];
    Some(Target { url: urls.chatgpt.clone(), token: access_token, extra })
}

fn stream_event(data: &str) -> Option<(String, Option<String>)> {
    let event: Value = serde_json::from_str(data).ok()?;
    let kind = event.get("type")?.as_str()?.to_string();
    match event.get("delta") {
        None => Some((kind, None)),
        Some(Value::String(delta)) => Some((kind, Some(delta.clone()))),
        Some(_) => None,
    }
}

fn output_text(response: TitleHttpResponse) -> Result<Option<String>, TitleError> {
    if response.status == 429 || response.status >= 500 {
        return Ok(None);
    }
    if !(200..300).contains(&response.status) {
        return Err(TitleError::Status(response.status));
    }
    let mut reply = String::new();
    for line in response.body.split('\n') {
        let Some((kind, delta)) = line.strip_prefix("data:").and_then(stream_event) else {
            continue;
        };
        if kind == "error" || kind == "response.failed" {
            return Ok(None);
        }
        if kind == "response.output_text.delta" {
            reply.push_str(delta.as_deref().unwrap_or(""));
        }
    }
    Ok((!reply.is_empty()).then_some(reply))
}

fn is_line_terminator(character: char) -> bool {
    matches!(character, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

fn wrapped(text: &str) -> Option<&str> {
    for delimiter in ["\"", "'", "`", "**", "*"] {
        let inner = text.strip_prefix(delimiter).and_then(|rest| rest.strip_suffix(delimiter));
        if let Some(inner) = inner
            && !inner.contains(is_line_terminator)
        {
            return Some(inner);
        }
    }
    let rest = text.strip_prefix(['\u{201C}', '\u{2018}'])?;
    let inner = rest.strip_suffix(['\u{201D}', '\u{2019}'])?;
    (!inner.contains(is_line_terminator)).then_some(inner)
}

fn unwrap_title(text: &str) -> String {
    match wrapped(text) {
        Some(inner) => unwrap_title(inner.trim()),
        None => text.to_string(),
    }
}

/// Picks the first usable line of a model reply as a title of at most 48 UTF-16 units,
/// cut at a word boundary.
pub fn clean_title(reply: &str) -> Option<String> {
    let reply = THINK_BLOCK.replace_all(reply, "");
    for line in LINE_BREAK.split(&reply) {
        let bare = unwrap_title(&BULLET.replace(line.trim(), ""));
        let title = SPACES.replace_all(&unwrap_title(&LABEL.replace(&bare, "")), " ").into_owned();
        if SKIPPED.is_match(&title) {
            continue;
        }
        let units: Vec<u16> = title.encode_utf16().collect();
        if units.len() <= MAX_TITLE_COLUMNS {
            return Some(title);
        }
        let space = units[..=MAX_TITLE_COLUMNS].iter().rposition(|unit| *unit == u16::from(b' '));
        let end = space.filter(|space| *space > 0).unwrap_or(MAX_TITLE_COLUMNS);
        return Some(String::from_utf16_lossy(&units[..end]).trim().to_string());
    }
    None
}

async fn request_title(
    task: &str,
    client: &dyn TitleHttpClient,
    urls: &TitleEndpoints,
    home: &Path,
) -> Result<Option<String>, TitleError> {
    let Some(target) = credential(urls, home).await else {
        return Ok(None);
    };
    let mut headers = target.extra;
    headers.extend([
        ("Authorization".to_string(), format!("Bearer {}", target.token)),
        ("User-Agent".to_string(), "bb-host-daemon".to_string()),
        ("Accept".to_string(), "text/event-stream".to_string()),
        ("Content-Type".to_string(), "application/json".to_string()),
    ]);
    let content = json!([{ "type": "input_text", "text": format!("{TITLE_PROMPT}{task}") }]);
    let input = json!([{ "role": "user", "content": content }]);
    for model in MODELS {
        let body = json!({
            "instructions": INSTRUCTIONS,
            "reasoning": { "effort": "none" },
            "store": false,
            "stream": true,
            "model": model,
            "input": input,
        });
        let request = TitleHttpRequest {
            url: target.url.clone(),
            headers: headers.clone(),
            body: body.to_string(),
        };
        if let Some(reply) = output_text(client.post(request).await?)? {
            return Ok(clean_title(&reply));
        }
    }
    Ok(None)
}

/// `codexTitle`: titles `task` with the Codex CLI's own login (`<codex home>/auth.json`, read
/// only), giving up after five seconds. `Ok(None)` when there is no usable login or the
/// endpoint is rate limited or failing; cancel by dropping the future.
pub async fn codex_title(
    task: &str,
    client: &dyn TitleHttpClient,
    urls: &TitleEndpoints,
    codex_home_env: Option<&str>,
) -> Result<Option<String>, TitleError> {
    let home = codex_home(codex_home_env);
    tokio::time::timeout(BUDGET, request_title(task, client, urls, &home))
        .await
        .unwrap_or(Err(TitleError::Timeout))
}
