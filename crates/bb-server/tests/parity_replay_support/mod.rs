use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use bb_server::config::{ServerEnv, load_config};
use bb_server::db::threads::get_thread;
use bb_server::providers::catalog::enable_dev_providers_for_tests;
use bb_server::runners::local::local_runner_for;
use bb_server::server::{BbServer, CreateServerOptions, create_server};
use futures::{SinkExt, StreamExt};
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio_tungstenite::tungstenite::Message;

const BASE_TIME: i64 = 1_800_000_000_000;
const HOST_ID: &str = "host_parity000000";
/// The recorder drops these from its thread map before their scenario ends, so it never
/// fetched their timelines (and never advanced the clock for them).
const UNTRACKED_THREADS: &[&str] = &["archive-delete", "delete-parent", "delete-child"];
const MAX_DIFFS_PER_STEP: usize = 6;

#[derive(Clone, Debug, serde::Serialize)]
pub struct Diff {
    pub scenario: String,
    pub step: u64,
    pub method: String,
    pub path: String,
    #[serde(rename = "jsonPath")]
    pub json_path: String,
    pub recorded: Value,
    pub actual: Value,
}

impl Diff {
    pub fn line(&self) -> String {
        let short = |v: &Value| {
            let s = v.to_string();
            if s.chars().count() > 160 { format!("{}...", s.chars().take(160).collect::<String>()) } else { s }
        };
        format!(
            "{}#{} {} {}: {} {} vs {}",
            self.scenario,
            self.step,
            self.method,
            self.path,
            self.json_path,
            short(&self.recorded),
            short(&self.actual)
        )
    }
}

#[derive(Default)]
pub struct ScenarioResult {
    pub steps: usize,
    pub differing_steps: usize,
    pub diffs: Vec<Diff>,
}

pub fn results() -> &'static BTreeMap<String, ScenarioResult> {
    static RESULTS: OnceLock<BTreeMap<String, ScenarioResult>> = OnceLock::new();
    RESULTS.get_or_init(|| {
        std::thread::spawn(|| {
            let runtime =
                tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            runtime.block_on(replay_all())
        })
        .join()
        .unwrap()
    })
}

struct Socket {
    key: String,
    inbox: Arc<Mutex<Vec<Value>>>,
}

struct Replayer {
    server: BbServer,
    url: String,
    http: reqwest::Client,
    clock: Arc<AtomicI64>,
    paths: Vec<(String, String)>,
    rec_to_live: HashMap<String, String>,
    live_to_rec: HashMap<String, String>,
    sockets: Vec<Socket>,
    seen_turns: HashMap<String, i64>,
    detail_names: HashMap<String, String>,
    created: Vec<(String, String)>,
    captured: usize,
    pending_live: Vec<String>,
    fixture_dir: PathBuf,
    token: Regex,
    hostname: String,
}

fn git(repo: &Path, args: &[&str]) {
    let status = Command::new("git").args(args).current_dir(repo).status().unwrap();
    assert!(status.success(), "git {args:?}");
}

fn set_git_identity(home: &Path) {
    let vars = [
        ("GIT_CONFIG_GLOBAL", "/dev/null"),
        ("GIT_CONFIG_NOSYSTEM", "1"),
        ("GIT_AUTHOR_NAME", "Parity"),
        ("GIT_AUTHOR_EMAIL", "parity@example.com"),
        ("GIT_COMMITTER_NAME", "Parity"),
        ("GIT_COMMITTER_EMAIL", "parity@example.com"),
        ("GIT_AUTHOR_DATE", "2026-01-01T00:00:00Z"),
        ("GIT_COMMITTER_DATE", "2026-01-01T00:00:00Z"),
    ];
    // SAFETY: called once, from the single replay thread, before the server or any child starts.
    unsafe {
        for (key, _) in std::env::vars() {
            if ["BB_", "ANTHROPIC_", "CLAUDE_", "OPENAI_", "CODEX_", "GIT_"]
                .iter()
                .any(|prefix| key.starts_with(prefix))
            {
                std::env::remove_var(key);
            }
        }
        for (key, value) in vars {
            std::env::set_var(key, value);
        }
        std::env::set_var("HOME", home);
    }
}

async fn replay_all() -> BTreeMap<String, ScenarioResult> {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/parity");
    let steps: Vec<Value> =
        serde_json::from_str(&std::fs::read_to_string(fixture.join("conversation.json")).unwrap())
            .unwrap();
    let temp_dir = tempfile::Builder::new().prefix("bb-parity-").tempdir().unwrap();
    let temp: PathBuf = temp_dir.path().canonicalize().unwrap();
    let data_dir = temp.join("data");
    let repo = temp.join("repo");
    let home = temp.join("home");
    for dir in [&data_dir, &repo, &home] {
        std::fs::create_dir_all(dir).unwrap();
    }
    set_git_identity(&home);
    std::fs::write(data_dir.join("host-id"), format!("{HOST_ID}\n")).unwrap();
    std::fs::write(repo.join("README.md"), "# parity repo\n").unwrap();
    std::fs::create_dir_all(repo.join("src")).unwrap();
    std::fs::write(repo.join("src/a.ts"), "export const a = 1;\n").unwrap();
    git(&repo, &["init", "--quiet", "-b", "main"]);
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "--quiet", "-m", "initial"]);

    enable_dev_providers_for_tests();
    let s = |p: &Path| p.to_string_lossy().into_owned();
    let mut env: ServerEnv = [
        ("HOME", s(&home)),
        ("PATH", std::env::var("PATH").unwrap_or_default()),
        ("VITEST", "1".to_owned()),
        ("BB_DATA_DIR", s(&data_dir)),
        ("BB_SERVER_PORT", "0".to_owned()),
        ("BB_SERVER_BIND_HOST", "127.0.0.1".to_owned()),
        ("BB_DEV_PROVIDERS", "echo".to_owned()),
        ("BB_LOG_LEVEL", "silent".to_owned()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v))
    .collect();
    for (key, value) in std::env::vars().filter(|(k, _)| k.starts_with("GIT_")) {
        env.insert(key, value);
    }
    let config = load_config(&env).unwrap();
    let adapters = bb_runner::default_adapters()
        .into_iter()
        .filter(|adapter| adapter.id().as_str() == "echo")
        .collect();
    let (connect, local) = local_runner_for(&config, adapters);
    let clock = Arc::new(AtomicI64::new(BASE_TIME));
    let now_clock = clock.clone();
    let mut options = CreateServerOptions::new(config, connect);
    options.now = Some(Arc::new(move || now_clock.load(Ordering::SeqCst)));
    let server = create_server(options).unwrap();
    let listening = server.listen().await.unwrap();
    let url = listening.url.clone();
    let mut paths = vec![
        (s(&data_dir), "$DATA_DIR".to_owned()),
        (s(&repo), "$REPO".to_owned()),
        (s(&temp), "$TEMP".to_owned()),
    ];
    paths.push((url.trim_start_matches("http://").to_owned(), "$SERVER_HOST".to_owned()));
    let mut detail_names = HashMap::new();
    for step in &steps {
        if let (Some(sub), Some(id)) =
            (step["subscription"].as_str(), step["message"]["id"].as_str())
            && sub.starts_with("thread-detail:")
        {
            detail_names.entry(id.to_owned()).or_insert_with(|| sub.to_owned());
        }
    }
    let hostname = Command::new("hostname")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
        .unwrap_or_default();
    let mut replayer = Replayer {
        server,
        url,
        http: reqwest::Client::new(),
        clock,
        paths,
        rec_to_live: HashMap::new(),
        live_to_rec: HashMap::new(),
        sockets: Vec::new(),
        seen_turns: HashMap::new(),
        detail_names,
        created: Vec::new(),
        captured: 0,
        pending_live: Vec::new(),
        fixture_dir: fixture.clone(),
        token: Regex::new(
            r"\b(?:(?:thr|env|evt|proj|pint|qmsg|tpv|sec|src|creq|phist|tok|req|att|run|hst|auto|task)_[a-z0-9]{10}|[0-9a-f]{10}-[ti]|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|timeline-v3:[A-Za-z0-9_-]+)",
        )
        .unwrap_or_else(|_| fallback_token_regex()),
        hostname,
    };
    let mut results: BTreeMap<String, ScenarioResult> = BTreeMap::new();
    let mut current = String::new();
    let mut ws_steps: Vec<Value> = Vec::new();
    for step in &steps {
        let scenario = step["scenario"].as_str().unwrap_or_default().to_owned();
        if scenario != current {
            if !current.is_empty() {
                let result = results.entry(current.clone()).or_default();
                replayer.flush(&current, std::mem::take(&mut ws_steps), result).await;
                replayer.capture_fixtures(&current, result).await;
            }
            current = scenario.clone();
            if scenario == "thread-basics" {
                replayer.subscribe("thread-list".to_owned(), json!({"kind": "thread-list"})).await;
            }
        }
        let result = results.entry(scenario.clone()).or_default();
        match step["kind"].as_str() {
            Some("ws") => ws_steps.push(step.clone()),
            Some("http") => {
                result.steps += 1;
                let diffs = replayer.http_step(step).await;
                if !diffs.is_empty() {
                    result.differing_steps += 1;
                }
                result.diffs.extend(diffs);
            }
            Some("wait") => {
                result.steps += 1;
                let diffs = replayer.wait_step(step).await;
                if !diffs.is_empty() {
                    result.differing_steps += 1;
                }
                result.diffs.extend(diffs);
            }
            _ => {}
        }
    }
    let result = results.entry(current.clone()).or_default();
    replayer.flush(&current, ws_steps, result).await;
    replayer.capture_fixtures(&current, result).await;
    replayer.server.close().await;
    local.shutdown().await;
    drop(temp_dir);
    if let Ok(report) = std::env::var("PARITY_REPORT") {
        let mut out = String::new();
        for diff in results.values().flat_map(|r| &r.diffs) {
            out.push_str(&serde_json::to_string(diff).unwrap());
            out.push('\n');
        }
        std::fs::write(report, out).unwrap();
    }
    results
}

fn split_echo_key(token: &str) -> (&str, &str) {
    if token.len() == 12 && (token.ends_with("-t") || token.ends_with("-i")) {
        token.split_at(10)
    } else {
        (token, "")
    }
}

fn fallback_token_regex() -> Regex {
    Regex::new(r"\b(?:thr|env|evt|proj|pint|qmsg|tpv|sec|src|creq|phist)_[a-z0-9]{10}\b").unwrap()
}

fn diff(step: &Value, path: &str, recorded: Value, actual: Value) -> Diff {
    Diff {
        scenario: step["scenario"].as_str().unwrap_or_default().to_owned(),
        step: step["step"].as_u64().unwrap_or_default(),
        method: step["request"]["method"].as_str().unwrap_or("WS").to_owned(),
        path: step["request"]["path"]
            .as_str()
            .or(step["subscription"].as_str())
            .or(step["waitFor"].as_str())
            .unwrap_or_default()
            .to_owned(),
        json_path: path.to_owned(),
        recorded,
        actual,
    }
}

impl Replayer {
    fn to_live(&self, text: &str) -> String {
        let mut out = text.to_owned();
        for (live, placeholder) in &self.paths {
            out = out.replace(placeholder, live);
        }
        self.token
            .replace_all(&out, |c: &regex::Captures| {
                let (key, suffix) = split_echo_key(&c[0]);
                let live = self.rec_to_live.get(key).map_or(key, String::as_str);
                format!("{live}{suffix}")
            })
            .into_owned()
    }

    fn live_value(&self, value: &Value) -> Value {
        match value {
            Value::String(s) => Value::String(self.to_live(s)),
            Value::Array(items) => Value::Array(items.iter().map(|v| self.live_value(v)).collect()),
            Value::Object(map) => Value::Object(
                map.iter().map(|(k, v)| (self.to_live(k), self.live_value(v))).collect(),
            ),
            other => other.clone(),
        }
    }

    fn sanitize(&self, text: &str) -> String {
        let mut out = text.to_owned();
        for (live, placeholder) in &self.paths {
            out = out.replace(live.as_str(), placeholder);
        }
        out
    }

    fn sanitize_value(&self, value: &Value) -> Value {
        match value {
            Value::String(s) if !self.hostname.is_empty() && *s == self.hostname => {
                Value::String("bee".to_owned())
            }
            Value::String(s) => Value::String(self.sanitize(s)),
            Value::Array(items) => {
                Value::Array(items.iter().map(|v| self.sanitize_value(v)).collect())
            }
            Value::Object(map) => Value::Object(
                map.iter().map(|(k, v)| (self.sanitize(k), self.sanitize_value(v))).collect(),
            ),
            other => other.clone(),
        }
    }

    fn bind(&mut self, recorded: &str, live: &str) -> bool {
        match (self.rec_to_live.get(recorded), self.live_to_rec.get(live)) {
            (Some(l), _) => l == live,
            (None, Some(_)) => false,
            (None, None) => {
                self.rec_to_live.insert(recorded.to_owned(), live.to_owned());
                self.live_to_rec.insert(live.to_owned(), recorded.to_owned());
                true
            }
        }
    }

    fn decode_cursor(&self, token: &str) -> Option<Value> {
        let raw = token.strip_prefix("timeline-v3:")?;
        let bytes = URL_SAFE_NO_PAD.decode(raw.trim_end_matches('=')).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    fn strings_match(&mut self, recorded: &str, actual: &str) -> bool {
        let rec_tokens: Vec<(usize, usize)> =
            self.token.find_iter(recorded).map(|m| (m.start(), m.end())).collect();
        let act_tokens: Vec<(usize, usize)> =
            self.token.find_iter(actual).map(|m| (m.start(), m.end())).collect();
        if rec_tokens.len() != act_tokens.len() {
            return false;
        }
        let (mut ri, mut ai) = (0, 0);
        let mut ok = true;
        for (&(rs, re), &(as_, ae)) in rec_tokens.iter().zip(&act_tokens) {
            if recorded[ri..rs] != actual[ai..as_] {
                return false;
            }
            let (r, a) = (&recorded[rs..re], &actual[as_..ae]);
            if r.starts_with("timeline-v3:") {
                let (rv, av) = (self.decode_cursor(r), self.decode_cursor(a));
                let av = av.map(|v| self.sanitize_value(&v));
                let mut sub = Vec::new();
                match (rv, av) {
                    (Some(rv), Some(av)) => self.compare("$", &rv, &av, &mut sub),
                    _ => ok = false,
                }
                ok &= sub.is_empty();
                if ok {
                    self.rec_to_live.insert(r.to_owned(), a.to_owned());
                }
            } else {
                let ((r, rs), (a, as_)) = (split_echo_key(r), split_echo_key(a));
                let prefix = |t: &str| t.split_once('_').map(|(p, _)| p.to_owned());
                ok &= rs == as_ && prefix(r) == prefix(a) && self.bind(r, a);
            }
            (ri, ai) = (re, ae);
        }
        ok && recorded[ri..] == actual[ai..]
    }

    fn compare(&mut self, path: &str, recorded: &Value, actual: &Value, out: &mut Vec<(String, Value, Value)>) {
        if out.len() >= MAX_DIFFS_PER_STEP {
            return;
        }
        match (recorded, actual) {
            (Value::String(r), Value::String(a)) => {
                if !self.strings_match(r, a) {
                    out.push((path.to_owned(), recorded.clone(), actual.clone()));
                }
            }
            (Value::Array(r), Value::Array(a)) => {
                if r.len() != a.len() {
                    out.push((format!("{path}.length"), json!(r.len()), json!(a.len())));
                }
                for (i, (rv, av)) in r.iter().zip(a).enumerate() {
                    self.compare(&format!("{path}[{i}]"), rv, av, out);
                }
            }
            (Value::Object(r), Value::Object(a)) => {
                for (key, rv) in r {
                    let child = format!("{path}.{key}");
                    if key == "modifiedAtMs" {
                        continue;
                    }
                    match a.get(key) {
                        Some(av) => self.compare(&child, rv, av, out),
                        None => out.push((child, rv.clone(), json!("<missing>"))),
                    }
                }
                for (key, av) in a {
                    if !r.contains_key(key) && key != "modifiedAtMs" {
                        out.push((format!("{path}.{key}"), json!("<missing>"), av.clone()));
                    }
                }
            }
            (r, a) if r == a => {}
            _ => out.push((path.to_owned(), recorded.clone(), actual.clone())),
        }
    }

    fn compare_step(&mut self, step: &Value, prefix: &str, recorded: &Value, actual: &Value) -> Vec<Diff> {
        let actual = self.sanitize_value(actual);
        let mut out = Vec::new();
        self.compare(prefix, recorded, &actual, &mut out);
        out.into_iter().map(|(p, r, a)| diff(step, &p, r, a)).collect()
    }

    async fn http_step(&mut self, step: &Value) -> Vec<Diff> {
        let request = &step["request"];
        let method = request["method"].as_str().unwrap_or("GET");
        let request_text = request.to_string();
        let unbound: Vec<String> = self
            .token
            .find_iter(&request_text)
            .map(|m| m.as_str().to_owned())
            .filter(|t| t.starts_with("pint_") && !self.rec_to_live.contains_key(t))
            .collect();
        for recorded in unbound {
            if let Some(live) = self.pending_live.first().cloned() {
                self.bind(&recorded, &live);
            }
        }
        let path = self.to_live(request["path"].as_str().unwrap_or_default());
        self.clock.fetch_add(1000, Ordering::SeqCst);
        let mut target = reqwest::Url::parse(&format!("{}{path}", self.url)).unwrap();
        if let Some(query) = request["query"].as_object() {
            let mut pairs = target.query_pairs_mut();
            for (k, v) in query {
                pairs.append_pair(k, &self.to_live(v.as_str().unwrap_or_default()));
            }
        }
        if request["query"].as_object().is_none_or(Map::is_empty) {
            target.set_query(None);
        }
        let mut builder =
            self.http.request(reqwest::Method::from_bytes(method.as_bytes()).unwrap(), target);
        match &request["body"] {
            Value::Null => {}
            Value::String(raw) => {
                builder = builder.header("content-type", "application/json").body(raw.clone());
            }
            body => {
                let body = self.live_value(body);
                builder = builder
                    .header("content-type", "application/json")
                    .body(serde_json::to_string(&body).unwrap());
            }
        }
        let response = match builder.send().await {
            Ok(response) => response,
            Err(error) => return vec![diff(step, "$request", Value::Null, json!(error.to_string()))],
        };
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        let bytes = response.bytes().await.unwrap_or_default();
        let body = if bytes.is_empty() {
            Value::Null
        } else if content_type.contains("json") {
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| json!({"unparsedJson": String::from_utf8_lossy(&bytes)}))
        } else {
            let sha = Sha256::digest(&bytes);
            let hex: String = sha.iter().map(|b| format!("{b:02x}")).collect();
            json!({"contentType": content_type, "length": bytes.len(), "sha256": hex})
        };
        let mut diffs = Vec::new();
        let recorded_status = step["response"]["status"].as_u64().unwrap_or_default();
        if recorded_status != u64::from(status) {
            diffs.push(diff(step, "$status", json!(recorded_status), json!(status)));
        }
        let recorded_body = step["response"]["body"].clone();
        let body_for_compare = mask_path_values(&recorded_body, &body);
        diffs.extend(self.compare_step(step, "$", &recorded_body, &body_for_compare));
        if method == "POST"
            && request["path"] == "/api/v1/threads"
            && let Some(live_id) = body["id"].as_str()
        {
            let rec_id = recorded_body["id"].as_str().unwrap_or(live_id).to_owned();
            let key = self
                .detail_names
                .get(&rec_id)
                .cloned()
                .unwrap_or_else(|| format!("thread-detail:{rec_id}"));
            self.created.push((rec_id.clone(), live_id.to_owned()));
            self.subscribe(key, json!({"kind": "thread-detail", "threadId": live_id})).await;
        }
        diffs
    }

    async fn wait_step(&mut self, step: &Value) -> Vec<Diff> {
        let rec_id = step["threadId"].as_str().unwrap_or_default();
        let id = self.to_live(rec_id);
        let deadline = Instant::now() + Duration::from_secs(20);
        let what = step["waitFor"].as_str().unwrap_or_default().to_owned();
        let ctx = self.server.ctx.clone();
        let row = |id: &str| -> Value {
            get_thread(&ctx.db, id)
                .ok()
                .flatten()
                .map(|t| serde_json::to_value(t).unwrap_or_default())
                .unwrap_or_default()
        };
        let turns = |id: &str| -> i64 {
            ctx.db
                .scalar::<i64>(
                    "SELECT count(*) FROM events WHERE thread_id = ? AND type = 'turn/completed'",
                    [id],
                )
                .ok()
                .flatten()
                .unwrap_or_default()
        };
        loop {
            let done = match what.as_str() {
                "thread-settled" => {
                    let r = row(&id);
                    r.is_object()
                        && r["activeTurnId"].is_null()
                        && matches!(r["status"].as_str(), Some("idle" | "error"))
                        && turns(&id) > self.seen_turns.get(&id).copied().unwrap_or_default()
                }
                "turn-active" => !row(&id)["activeTurnId"].is_null(),
                "pending-interaction" => {
                    let url = format!("{}/api/v1/threads/{id}/interactions", self.url);
                    match self.http.get(url).send().await {
                        Ok(r) => {
                            let list = r.json::<Value>().await.unwrap_or_default();
                            let ids: Vec<String> = list
                                .as_array()
                                .map(|a| {
                                    a.iter()
                                        .filter_map(|i| i["id"].as_str().map(str::to_owned))
                                        .collect()
                                })
                                .unwrap_or_default();
                            let found = !ids.is_empty();
                            self.pending_live = ids;
                            found
                        }
                        Err(_) => false,
                    }
                }
                _ => true,
            };
            if done {
                break;
            }
            if Instant::now() > deadline {
                return vec![diff(step, "$wait", json!(what), json!(format!("timed out: {}", row(&id))))];
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        if what != "thread-settled" {
            return Vec::new();
        }
        self.seen_turns.insert(id.clone(), turns(&id));
        bb_server::threads::engine::settled(&ctx).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        bb_server::threads::engine::settled(&ctx).await;
        let r = row(&id);
        let observed = json!({"status": r["status"], "activeTurnId": r["activeTurnId"]});
        self.compare_step(step, "$observed", &step["observed"], &observed)
    }

    async fn subscribe(&mut self, key: String, target: Value) {
        let url = format!("{}/ws", self.url.replacen("http", "ws", 1));
        let (stream, _) = tokio_tungstenite::connect_async(url).await.unwrap();
        let (mut sink, mut source) = stream.split();
        let subscribe = json!({"type": "subscribe", "target": target}).to_string();
        sink.send(Message::Text(subscribe.into())).await.unwrap();
        sink.send(Message::Text(json!({"type": "ping"}).to_string().into())).await.unwrap();
        let inbox = Arc::new(Mutex::new(Vec::new()));
        let pong = Arc::new(AtomicBool::new(false));
        let (task_inbox, task_pong) = (inbox.clone(), pong.clone());
        tokio::spawn(async move {
            let _sink = sink;
            while let Some(Ok(message)) = source.next().await {
                if let Message::Text(text) = message
                    && let Ok(value) = serde_json::from_str::<Value>(&text)
                {
                    if value["type"] == "pong" {
                        task_pong.store(true, Ordering::SeqCst);
                    } else {
                        task_inbox.lock().push(value);
                    }
                }
            }
        });
        let deadline = Instant::now() + Duration::from_secs(10);
        while !pong.load(Ordering::SeqCst) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        self.sockets.push(Socket { key, inbox });
    }

    async fn fetch_timeline(&self, path: &str, query: &[(&str, String)]) -> Value {
        self.clock.fetch_add(1000, Ordering::SeqCst);
        let mut target = reqwest::Url::parse(&format!("{}/api/v1{path}", self.url)).unwrap();
        for (k, v) in query {
            target.query_pairs_mut().append_pair(k, v);
        }
        let query: Map<String, Value> =
            query.iter().map(|(k, v)| ((*k).to_owned(), json!(v))).collect();
        match self.http.get(target).send().await {
            Ok(r) => {
                let status = r.status().as_u16();
                let body = r.json::<Value>().await.unwrap_or(Value::Null);
                json!({"query": query, "status": status, "body": body})
            }
            Err(e) => json!({"query": query, "status": 0, "body": e.to_string()}),
        }
    }

    async fn capture_fixtures(&mut self, scenario: &str, result: &mut ScenarioResult) {
        while self.captured < self.created.len() {
            let (rec_id, id) = self.created[self.captured].clone();
            self.captured += 1;
            let name = self.detail_names.get(&rec_id).cloned().unwrap_or_default();
            if UNTRACKED_THREADS.iter().any(|n| name == format!("thread-detail:{n}")) {
                continue;
            }
            let base = format!("/threads/{id}/timeline");
            let mut timeline = Vec::new();
            let first = self.fetch_timeline(&base, &[]).await;
            timeline.push(first.clone());
            timeline.push(self.fetch_timeline(&base, &[("includeNestedRows", "true".into())]).await);
            timeline.push(self.fetch_timeline(&base, &[("summaryOnly", "true".into())]).await);
            let page = self.fetch_timeline(&base, &[("segmentLimit", "2".into())]).await;
            timeline.push(page.clone());
            let anchor = &page["body"]["rows"][0];
            if let Some(seq) = anchor["sourceSeqStart"].as_i64() {
                let anchor_id = match &anchor["id"] {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                let query = [
                    ("segmentLimit", "2".to_owned()),
                    ("beforeAnchorSeq", seq.to_string()),
                    ("beforeAnchorId", anchor_id),
                ];
                timeline.push(self.fetch_timeline(&base, &query).await);
            }
            timeline.push(self.fetch_timeline(&base, &[("afterSequence", "3".into())]).await);
            let rows = first["body"]["rows"].as_array().cloned().unwrap_or_default();
            let summary = rows.iter().find(|r| {
                r["sourceSeqStart"].is_number()
                    && r["sourceSeqEnd"].is_number()
                    && (r["kind"] == "turn"
                        || r["kind"].as_str().is_some_and(|k| k.to_lowercase().contains("summary")))
            });
            let mut details = Value::Null;
            if let Some(summary) = summary {
                let query = [
                    ("turnId", summary["turnId"].as_str().unwrap_or_default().to_owned()),
                    ("sourceSeqStart", summary["sourceSeqStart"].to_string()),
                    ("sourceSeqEnd", summary["sourceSeqEnd"].to_string()),
                ];
                details =
                    self.fetch_timeline(&format!("{base}/turn-summary-details"), &query).await;
            }
            let Some(name) = self.detail_names.get(&rec_id).cloned() else { continue };
            let name = name.trim_start_matches("thread-detail:").to_owned();
            let file = self.fixture_dir.join(format!("threads/{name}.json"));
            let Ok(text) = std::fs::read_to_string(&file) else { continue };
            let recorded: Value = serde_json::from_str(&text).unwrap();
            let anchor = json!({"scenario": scenario, "step": 0, "subscription": format!("fixture:{name}")});
            let actual = json!({"timeline": timeline, "turnSummaryDetails": details});
            let expected = json!({"timeline": recorded["timeline"], "turnSummaryDetails": recorded["turnSummaryDetails"]});
            let diffs = self.compare_step(&anchor, "$", &expected, &actual);
            result.steps += 1;
            if !diffs.is_empty() {
                result.differing_steps += 1;
            }
            result.diffs.extend(diffs);
        }
    }

    async fn flush(&mut self, scenario: &str, recorded: Vec<Value>, result: &mut ScenarioResult) {
        let mut by_key: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        for step in recorded {
            by_key.entry(step["subscription"].as_str().unwrap_or_default().to_owned()).or_default().push(step);
        }
        let mut live: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        for socket in &self.sockets {
            live.entry(socket.key.clone()).or_default().extend(socket.inbox.lock().drain(..));
        }
        let keys: Vec<String> = by_key.keys().chain(live.keys()).cloned().collect();
        let mut done = std::collections::BTreeSet::new();
        for key in keys {
            if !done.insert(key.clone()) {
                continue;
            }
            let rec = by_key.remove(&key).unwrap_or_default();
            let act = live.remove(&key).unwrap_or_default();
            if rec.is_empty() && act.is_empty() {
                continue;
            }
            result.steps += 1;
            let anchor = rec.first().cloned().unwrap_or_else(|| {
                json!({"scenario": scenario, "step": 0, "subscription": key})
            });
            let rec_msgs: Vec<Value> = rec.iter().map(|s| s["message"].clone()).collect();
            let diffs = self.compare_step(&anchor, "$ws", &Value::Array(rec_msgs), &Value::Array(act));
            if !diffs.is_empty() {
                result.differing_steps += 1;
            }
            result.diffs.extend(diffs);
        }
    }
}

fn mask_path_values(recorded: &Value, actual: &Value) -> Value {
    fn walk(r: &Value, a: &Value) -> Value {
        match (r, a) {
            (Value::Object(rm), Value::Object(am)) => {
                let is_path = am.get("name").and_then(Value::as_str) == Some("PATH")
                    || am.get("key").and_then(Value::as_str) == Some("PATH");
                Value::Object(
                    am.iter()
                        .map(|(k, v)| {
                            let value = match rm.get(k) {
                                Some(rv) if is_path && k == "value" => rv.clone(),
                                Some(rv) => walk(rv, v),
                                None => v.clone(),
                            };
                            (k.clone(), value)
                        })
                        .collect(),
                )
            }
            (Value::Array(ra), Value::Array(aa)) => Value::Array(
                aa.iter()
                    .enumerate()
                    .map(|(i, v)| ra.get(i).map_or_else(|| v.clone(), |rv| walk(rv, v)))
                    .collect(),
            ),
            _ => a.clone(),
        }
    }
    walk(recorded, actual)
}
