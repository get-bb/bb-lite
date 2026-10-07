use std::sync::LazyLock;

use bytes::Bytes;
use http::{HeaderMap, Uri};
use regex::Regex;
use serde_json::{Map, Value};

use crate::contract::{Account, ModelFamily, is_uuid};
use crate::limits::{header, model_family};

const UUID: &str = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
static ACCOUNT_COMPONENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!("(?i)(^|_)account_({UUID})")).expect("account component pattern")
});
static SESSION_COMPONENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!("(?i)(?:^|_)session_({UUID})$")).expect("session component pattern")
});

#[derive(Debug, Clone)]
enum UserRewrite {
    Json { encoded: Map<String, Value>, stored: Option<Option<String>> },
    Plain(String),
}

#[derive(Debug, Clone)]
enum Rewrite {
    Untouched,
    Claude { request: Map<String, Value>, user: Option<UserRewrite> },
}

#[derive(Debug, Clone)]
pub struct ParsedRequest {
    pub family: ModelFamily,
    pub affinity_id: Option<String>,
    pub parent_affinity_id: Option<String>,
    body: Bytes,
    rewrite: Rewrite,
}

impl ParsedRequest {
    /// The body to forward for `account`; Claude bodies carry the account UUID in `metadata.user_id`.
    pub fn for_account(&self, account: &Account) -> Bytes {
        let Rewrite::Claude { request, user: Some(user) } = &self.rewrite else {
            return self.body.clone();
        };
        let Some(account_uuid) = account.account_uuid.as_deref() else {
            return self.body.clone();
        };
        let Some(rewritten) = rewrite_user(user, account_uuid) else {
            return self.body.clone();
        };
        let mut request = request.clone();
        if let Some(Value::Object(metadata)) = request.get_mut("metadata") {
            metadata.insert("user_id".into(), Value::String(rewritten));
        }
        Bytes::from(Value::Object(request).to_string())
    }
}

fn json_record(text: Option<&str>) -> Option<Map<String, Value>> {
    match serde_json::from_str(text.unwrap_or("")) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

fn identifier(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) => identifier_str(Some(text)),
        _ => None,
    }
}

fn identifier_str(value: Option<&str>) -> Option<String> {
    let text = value?;
    let usable = text.encode_utf16().count() <= 512
        && !text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}').is_empty()
        && !text.chars().any(char::is_control);
    usable.then(|| text.to_string())
}

fn session(id: Option<String>) -> Option<String> {
    id.map(|id| format!("session:{id}"))
}

fn rewrite_user(user: &UserRewrite, account_uuid: &str) -> Option<String> {
    match user {
        UserRewrite::Json { encoded, stored } => {
            let stored = stored.as_ref()?;
            if stored.as_deref() == Some(account_uuid) {
                return None;
            }
            let mut encoded = encoded.clone();
            encoded.insert("account_uuid".into(), Value::String(account_uuid.into()));
            Some(Value::Object(encoded).to_string())
        }
        UserRewrite::Plain(user_id) => {
            let mut start = 0;
            while let Some(caps) = ACCOUNT_COMPONENT.captures_at(user_id, start) {
                let whole = caps.get(0)?;
                let rest = &user_id[whole.end()..];
                if rest.is_empty() || rest.starts_with('_') {
                    let prefix = caps.get(1).map_or("", |m| m.as_str());
                    let replaced = format!(
                        "{}{prefix}account_{account_uuid}{rest}",
                        &user_id[..whole.start()]
                    );
                    return (replaced != *user_id).then_some(replaced);
                }
                start = whole.start() + 1;
            }
            None
        }
    }
}

fn parse_user_id(user_id: &str) -> (Option<String>, Option<String>, UserRewrite) {
    if let Some(encoded) = json_record(Some(user_id)) {
        let stored = match encoded.get("account_uuid") {
            Some(Value::Null) => Some(None),
            Some(Value::String(id)) if is_uuid(id) => Some(Some(id.clone())),
            _ => None,
        };
        let session_id = identifier(encoded.get("session_id"));
        let parent = identifier(encoded.get("parent_session_id"));
        let parent = if session_id.is_none() || parent == session_id { None } else { parent };
        return (session_id, parent, UserRewrite::Json { encoded, stored });
    }
    let session_id = SESSION_COMPONENT
        .captures(user_id)
        .and_then(|caps| identifier_str(caps.get(1).map(|m| m.as_str())));
    (session_id, None, UserRewrite::Plain(user_id.to_string()))
}

fn loose_object(value: Option<&Value>) -> Result<Option<&Map<String, Value>>, ()> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(map)) => Ok(Some(map)),
        Some(_) => Err(()),
    }
}

fn nullish_string(value: Option<&Value>) -> Result<Option<&str>, ()> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text)),
        Some(_) => Err(()),
    }
}

fn shape_first(map: &Map<String, Value>, keys: &[&str]) -> Map<String, Value> {
    let mut ordered: Map<String, Value> =
        keys.iter().filter_map(|key| Some((key.to_string(), map.get(*key)?.clone()))).collect();
    for (key, value) in map {
        if !keys.contains(&key.as_str()) {
            ordered.insert(key.clone(), value.clone());
        }
    }
    ordered
}

pub fn parse_claude_request(body: Bytes) -> ParsedRequest {
    let untouched = |body: Bytes| ParsedRequest {
        family: ModelFamily::Other,
        affinity_id: None,
        parent_affinity_id: None,
        body,
        rewrite: Rewrite::Untouched,
    };
    let Some(record) = json_record(Some(&String::from_utf8_lossy(&body))) else {
        return untouched(body);
    };
    let Ok(model) = nullish_string(record.get("model")) else { return untouched(body) };
    let Ok(metadata) = loose_object(record.get("metadata")) else { return untouched(body) };
    let Ok(user_id) = nullish_string(metadata.and_then(|m| m.get("user_id"))) else {
        return untouched(body);
    };
    let family = model_family(model);
    let user = user_id.map(parse_user_id);
    let (session_id, parent_id) = match &user {
        Some((session_id, parent, _)) => (session_id.clone(), parent.clone()),
        None => (None, None),
    };
    let mut request = shape_first(&record, &["model", "metadata"]);
    if let Some(metadata) = metadata {
        request.insert("metadata".into(), Value::Object(shape_first(metadata, &["user_id"])));
    }
    ParsedRequest {
        family,
        affinity_id: session(session_id),
        parent_affinity_id: session(parent_id),
        body,
        rewrite: Rewrite::Claude { request, user: user.map(|(_, _, rewrite)| rewrite) },
    }
}

pub fn parse_codex_request(body: Bytes, headers: &HeaderMap) -> ParsedRequest {
    let request = json_record(Some(&String::from_utf8_lossy(&body)));
    let field = |key: &str| request.as_ref().and_then(|request| request.get(key));
    let client = field("client_metadata").and_then(Value::as_object);
    let client_field = |key: &str| client.and_then(|client| client.get(key));
    let embedded = client_field("x-codex-turn-metadata").and_then(Value::as_str);
    let header_turn = json_record(header(headers, "x-codex-turn-metadata").as_deref());
    let body_turn = json_record(embedded);
    let turn = |turn: &Option<Map<String, Value>>, key: &str| {
        identifier(turn.as_ref().and_then(|turn| turn.get(key)))
    };
    let named = |name: &str| identifier_str(header(headers, name).as_deref());
    let session_candidates = [
        named("thread-id"),
        turn(&header_turn, "thread_id"),
        identifier(client_field("thread_id")),
        turn(&body_turn, "thread_id"),
        named("session-id"),
        named("session_id"),
        turn(&header_turn, "session_id"),
        identifier(client_field("session_id")),
        turn(&body_turn, "session_id"),
    ];
    let session_id = session_candidates.into_iter().flatten().next();
    let parents = [
        turn(&header_turn, "forked_from_thread_id"),
        turn(&body_turn, "forked_from_thread_id"),
        named("x-codex-parent-thread-id"),
        turn(&header_turn, "parent_thread_id"),
        identifier(client_field("x-codex-parent-thread-id")),
        turn(&body_turn, "parent_thread_id"),
    ];
    let parent = session_id
        .as_ref()
        .and_then(|session_id| parents.into_iter().flatten().find(|id| id != session_id));
    let cache_key = identifier(field("prompt_cache_key"));
    let affinity_id = session(session_id).or(cache_key.map(|key| format!("cache:{key}")));
    ParsedRequest {
        family: ModelFamily::Other,
        affinity_id,
        parent_affinity_id: session(parent),
        body,
        rewrite: Rewrite::Untouched,
    }
}

pub fn upstream_headers(inbound: &HeaderMap, allowed: &[&str], prefixes: &[&str]) -> HeaderMap {
    let mut headers = HeaderMap::new();
    for (name, value) in inbound {
        let prefixed = prefixes.iter().any(|prefix| name.as_str().starts_with(prefix));
        if allowed.contains(&name.as_str()) || prefixed {
            headers.append(name.clone(), value.clone());
        }
    }
    headers
}

/// Maps a hub request (`.../http/<path>?<query>`) onto `base_url`, dropping `strip_prefix` from the path.
pub fn upstream_url(
    request: &Uri,
    base_url: &str,
    strip_prefix: &str,
) -> Result<url::Url, url::ParseError> {
    let pathname = request.path();
    let mounted = pathname.find("/http/").map_or(pathname, |index| &pathname[index + 5..]);
    let path = mounted.strip_prefix('/').unwrap_or(mounted);
    let relative = path.strip_prefix(strip_prefix).unwrap_or(path);
    let search = match request.query() {
        Some(query) if !query.is_empty() => format!("?{query}"),
        _ => String::new(),
    };
    let base = if base_url.ends_with('/') { base_url.to_string() } else { format!("{base_url}/") };
    url::Url::parse(&base)?.join(&format!("{relative}{search}"))
}
