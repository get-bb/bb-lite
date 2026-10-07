//! `plugins/tasks/test/tasks.test.ts`, ported: the real tasks bundle runs in
//! QuickJS through the `PluginHost`, and the fake `PluginOutward` stands in
//! for the server's threads and files.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use axum::body::Body;
use axum::extract::Request;
use bb_server::config::ServerConfig;
use bb_server::db::Db;
use bb_server::error::ApiResult;
use bb_server::log::{LogLevel, Logger};
use bb_server::plugins::api::*;
use bb_server::plugins::builtin::builtin_plugins;
use bb_server::plugins::host::{PluginHost, PluginHostOptions};
use bb_server::ws::hub::{Hub, HubSocket};
use parking_lot::Mutex;
use serde_json::{Value, json};

const PNG: [u8; 10] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00];
const AGENT: &str = "thr_agent";

fn ulid(suffix: &str) -> String {
    format!("01J8ZZZZZZZZZZZZZZZZZZZZ{suffix}")
}

#[derive(Default)]
struct Outward {
    calls: Mutex<Vec<(String, Value)>>,
    threads: Mutex<HashMap<String, Value>>,
    remote_file: Mutex<Option<FileRead>>,
}

impl Outward {
    fn record(&self, name: &str, value: Value) {
        self.calls.lock().push((name.to_owned(), value));
    }
    fn calls_to(&self, name: &str) -> Vec<Value> {
        self.calls.lock().iter().filter(|(n, _)| n == name).map(|(_, v)| v.clone()).collect()
    }
    fn add_thread(&self, id: &str, title: &str, status: &str) -> Value {
        let thread = json!({
            "id": id, "title": title, "titleFallback": null, "status": status,
            "deletedAt": null, "providerId": "codex", "projectId": "proj_1",
        });
        self.threads.lock().insert(id.to_owned(), thread.clone());
        thread
    }
}

#[async_trait]
impl PluginOutward for Outward {
    async fn threads_spawn(&self, request: Value) -> ApiResult<Value> {
        self.record("spawn", request.clone());
        let id = format!("thr_{}", self.threads.lock().len() + 1);
        Ok(self.add_thread(&id, request["title"].as_str().unwrap_or(""), "active"))
    }
    async fn threads_send(&self, id: &str, request: Value) -> ApiResult<Value> {
        self.record("send", json!({ "threadId": id, "request": request }));
        Ok(json!({}))
    }
    async fn threads_get(&self, id: &str) -> ApiResult<Option<Value>> {
        Ok(self.threads.lock().get(id).cloned())
    }
    async fn threads_list(&self, _: Value) -> ApiResult<Value> {
        Ok(json!({ "threads": self.threads.lock().values().cloned().collect::<Vec<_>>() }))
    }
    async fn threads_stop(&self, _: &str) -> ApiResult<()> {
        Ok(())
    }
    async fn threads_update(&self, _: &str, _: Value) -> ApiResult<Value> {
        Ok(Value::Null)
    }
    async fn threads_output(&self, _: &str) -> ApiResult<Option<String>> {
        Ok(Some("All done".into()))
    }
    async fn threads_events(&self, _: &str, _: Option<i64>) -> ApiResult<Vec<Value>> {
        Ok(Vec::new())
    }
    async fn projects_list(&self) -> ApiResult<Value> {
        Ok(json!([{ "id": "proj_1", "name": "bb" }]))
    }
    async fn hosts_list(&self) -> ApiResult<Value> {
        Ok(json!([]))
    }
    async fn sections_list(&self) -> ApiResult<Value> {
        Ok(json!([]))
    }
    async fn sections_create(&self, _: &str) -> ApiResult<Value> {
        Ok(Value::Null)
    }
    async fn files_read(&self, args: FileReadArgs) -> ApiResult<Option<FileRead>> {
        self.record("readFile", serde_json::to_value(&args).unwrap());
        Ok(self.remote_file.lock().clone())
    }
    async fn files_write(&self, args: FileWriteArgs) -> ApiResult<FileWriteOutcome> {
        self.record("writeFile", serde_json::to_value(&args).unwrap());
        Ok(FileWriteOutcome::Written { sha256: "s".into() })
    }
    async fn request_input(&self, _: InputRequest) -> InputResult {
        InputResult::Cancelled { reason: "test".into() }
    }
}

#[derive(Default)]
struct Socket(Mutex<Vec<Value>>);

impl HubSocket for Socket {
    fn send(&self, data: String) -> bool {
        self.0.lock().push(serde_json::from_str(&data).unwrap_or(Value::String(data)));
        true
    }
    fn close(&self, _: u16, _: &str) {}
}

type Http = (u16, Vec<(String, String)>, Vec<u8>);

struct Tasks {
    _temp: tempfile::TempDir,
    data_dir: std::path::PathBuf,
    host: PluginHost,
    outward: Arc<Outward>,
    socket: Arc<Socket>,
}

#[derive(Debug)]
struct Cli {
    exit_code: i32,
    stdout: String,
    stderr: String,
}

impl Cli {
    fn json(&self) -> Value {
        serde_json::from_str(&self.stdout)
            .unwrap_or_else(|e| panic!("{e}: {:?} / {:?}", self.stdout, self.stderr))
    }
}

/// Splits like the TypeScript test: `'quoted words'` or runs of non-space.
fn words(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = line.trim_start();
    while !rest.is_empty() {
        let end = if let Some(stripped) = rest.strip_prefix('\'') {
            stripped.find('\'').map_or(rest.len(), |i| i + 2)
        } else {
            rest.find(char::is_whitespace).unwrap_or(rest.len())
        };
        out.push(rest[..end].trim_matches('\'').to_owned());
        rest = rest[end..].trim_start();
    }
    out
}

impl Tasks {
    async fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let builtins =
            builtin_plugins().into_iter().filter(|p| p.directory.ends_with("tasks")).collect();
        let config = ServerConfig {
            data_dir: root.join("data"),
            port: 0,
            bind_host: "127.0.0.1".into(),
            allowed_hosts: Vec::new(),
            app_dir: root.join("app"),
            cli_dir: root.join("cli"),
            bb_cli_path: root.join("bb"),
            version: "0.0.0".into(),
            host_id: "host".into(),
            log_level: LogLevel::Silent,
        };
        let hub = Hub::new();
        let socket = Arc::new(Socket::default());
        hub.connect(socket.clone());
        let host = PluginHost::new(PluginHostOptions {
            config,
            db: Db::open_in_memory(None).unwrap(),
            hub,
            log: Logger::silent(),
            builtins: Some(builtins),
        });
        let outward = Arc::new(Outward::default());
        outward.add_thread(AGENT, "Agent thread", "idle");
        let deps = outward.clone();
        host.set_deps(Arc::new(move |_: &str| deps.clone() as Arc<dyn PluginOutward>));
        host.reload(None).await.unwrap();
        Self { data_dir: root.join("data"), _temp: temp, host, outward, socket }
    }

    async fn rpc(&self, method: &str, input: Value) -> Result<Value, String> {
        let instance = self.host.running("tasks").unwrap();
        let handler = instance.rpc(method).unwrap_or_else(|| panic!("no rpc {method}"));
        handler.call(input).await.map_err(|e| e.message)
    }

    async fn ok(&self, method: &str, input: Value) -> Value {
        self.rpc(method, input).await.unwrap_or_else(|e| panic!("{method}: {e}"))
    }

    async fn cli_in(&self, line: &str, thread: Option<&str>, cwd: Option<&str>) -> Cli {
        let cli = self.host.running("tasks").unwrap().cli().unwrap();
        let context = CliContext {
            cwd: cwd.map(str::to_owned),
            thread_id: thread.map(str::to_owned),
            project_id: thread.map(|_| "proj_1".to_owned()),
            ..Default::default()
        };
        let out = cli.run(words(line), context).await;
        Cli { exit_code: out.exit_code, stdout: out.stdout.trim().into(), stderr: out.stderr }
    }

    async fn cli(&self, line: &str) -> Cli {
        self.cli_in(line, None, None).await
    }

    async fn agent(&self, line: &str) -> Cli {
        self.cli_in(line, Some(AGENT), None).await
    }

    async fn http(&self, method: &str, path: &str, query: &str, body: &[u8]) -> Http {
        self.http_with(method, path, query, &[], body).await
    }

    async fn http_with(
        &self,
        method: &str,
        path: &str,
        query: &str,
        headers: &[(&str, &str)],
        body: &[u8],
    ) -> Http {
        let route = self.host.running("tasks").unwrap().route(&format!("{method} {path}")).unwrap();
        let uri = format!("/api/v1/plugins/tasks/http{path}?{query}");
        let mut request = Request::builder().method(method).uri(uri);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let request = request.body(Body::from(body.to_vec())).unwrap();
        let response = route.handler.handle(request).await;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap().to_owned()))
            .collect();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, headers, bytes.to_vec())
    }

    async fn seed(&self) -> (Value, Value, Value) {
        let tracker = json!({ "name": "bb", "prefix": "BB", "color": "slateblue", "linkedBbProjectId": "proj_1" });
        let project = self.ok("createProject", tracker).await["project"].clone();
        let tag = json!({ "projectId": project["id"], "name": "bug", "color": "indianred" });
        let label = self.ok("createLabel", tag).await["label"].clone();
        let input =
            json!({ "projectId": project["id"], "title": "Fix it", "labelIds": [label["id"]] });
        let task = self.ok("createTask", input).await["task"].clone();
        (project, label, task)
    }

    async fn detail(&self, key: &str) -> Value {
        self.ok("taskDetail", json!({ "taskKey": key })).await["detail"].clone()
    }

    async fn link_status(&self) -> Vec<Value> {
        let detail = self.detail("BB-1").await;
        detail["threads"].as_array().unwrap().iter().map(|t| t["liveStatus"].clone()).collect()
    }

    async fn eventually_status(&self, want: &str) {
        for _ in 0..200 {
            if self.link_status().await == vec![json!(want)] {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("link status never became {want}: {:?}", self.link_status().await);
    }
}

/// `toMatchObject`: every key in `want` is present and matches in `got`;
/// arrays must have the same length.
#[track_caller]
fn assert_match(got: &Value, want: &Value) {
    fn matches(got: &Value, want: &Value) -> bool {
        match (got, want) {
            (Value::Object(g), Value::Object(w)) => {
                w.iter().all(|(k, v)| g.get(k).is_some_and(|gv| matches(gv, v)))
            }
            (Value::Array(g), Value::Array(w)) => {
                g.len() == w.len() && g.iter().zip(w).all(|(g, w)| matches(g, w))
            }
            _ => got == want,
        }
    }
    assert!(matches(got, want), "\n got: {got:#}\nwant: {want:#}");
}

fn keys(value: &Value) -> Vec<&str> {
    value.as_object().unwrap().keys().map(String::as_str).collect()
}

#[tokio::test(flavor = "current_thread")]
async fn round_trips_tasks_labels_comments_and_mentions_over_rpc() {
    let t = Tasks::new().await;
    let (project, label, task) = t.seed().await;
    assert_match(&task, &json!({ "key": "BB-1", "status": "backlog", "number": 1 }));
    let signals = t.socket.0.lock().clone();
    assert!(
        signals.iter().any(|s| s["type"] == "plugin-signal" && s["pluginId"] == "tasks"),
        "{signals:?}"
    );

    let part = json!({ "projectId": project["id"], "parentTaskId": task["id"], "title": "Part one", "status": "todo" });
    let subtask = t.ok("createTask", part).await["task"].clone();
    let deep =
        json!({ "projectId": project["id"], "parentTaskId": subtask["id"], "title": "Too deep" });
    assert!(t.rpc("createTask", deep).await.unwrap_err().contains("one level"));
    let foreign = json!({ "taskId": task["id"], "labelIds": [ulid("ZZ")] });
    assert!(t.rpc("updateTask", foreign).await.unwrap_err().contains("must belong"));

    let query = MentionQuery {
        trigger: "@".into(),
        query: "fix".into(),
        project_id: Some("proj_1".into()),
        thread_id: None,
    };
    let groups = t.host.search_mentions(query).await;
    let item_id = format!("task:{}", task["id"].as_str().unwrap());
    let item = json!({ "itemId": item_id, "title": "BB-1 · Fix it", "subtitle": "bb · Backlog" });
    assert_match(&json!(groups), &json!([{ "providerId": "task", "items": [item] }]));
    let context = t.host.resolve_mention("tasks", &item_id).await.unwrap();
    assert!(context.contains("- Labels: bug\n- Project: bb"), "{context}");
    assert!(context.contains("first run: bb tasks attach BB-1"), "{context}");

    t.ok("updateTask", json!({ "taskId": task["id"], "status": "in_progress", "labelIds": [] }))
        .await;
    t.ok("createComment", json!({ "taskId": task["id"], "body": "Looks good", "notify": true }))
        .await;
    let found = t.detail("bb-1").await;
    assert_match(&found["task"], &json!({ "status": "in_progress", "labelIds": [] }));
    let subtasks: Vec<_> =
        found["subtasks"].as_array().unwrap().iter().map(|s| &s["key"]).collect();
    assert_eq!(subtasks, vec!["BB-2"]);
    assert_eq!(found["labels"], json!([label]));
    let activity: Vec<_> = found["comments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| json!([c["kind"], c["body"]]))
        .collect();
    assert_eq!(
        activity,
        vec![
            json!(["system", "Status changed to In Progress by You"]),
            json!(["system", "Labels cleared by You"]),
            json!(["user", "Looks good"]),
        ]
    );
    assert_match(&found["comments"][2], &json!({ "notifiedCount": 0, "provider": null }));
    assert_match(&t.detail("BB-2").await["parent"], &json!({ "key": "BB-1" }));

    let top = json!({ "parentTaskId": null, "statuses": ["in_progress", "done"] });
    let listed = t.ok("listTasks", top).await;
    let listed: Vec<_> = listed["tasks"].as_array().unwrap().iter().map(|s| &s["key"]).collect();
    assert_eq!(listed, vec!["BB-1"]);
    assert_match(
        &t.ok("overview", Value::Null).await,
        &json!({
            "projects": [{ "prefix": "BB", "nextTaskNumber": 3 }],
            "summaries": [{ "projectId": project["id"], "taskCount": 1, "activeAgentCount": 0 }],
            "openTaskCount": 2,
            "activeTaskCount": 0,
        }),
    );
    t.ok("updateLabel", json!({ "labelId": label["id"], "name": "defect" })).await;
    assert_match(
        &t.ok("listLabels", json!({})).await,
        &json!({ "labels": [{ "name": "defect", "color": "indianred" }] }),
    );
    assert_eq!(
        t.ok("deleteLabel", json!({ "labelId": label["id"] })).await,
        json!({ "deleted": true })
    );
    t.host.stop().await;
}

#[tokio::test(flavor = "current_thread")]
async fn serves_the_agent_cli_with_the_original_flags_and_json_shapes() {
    let t = Tasks::new().await;
    t.seed().await;
    assert_eq!(t.cli("status --json").await.json(), json!({ "name": "Tasks", "version": "0.1.2" }));
    let child = t.agent("create --title Child --description Spec --parent bb-1").await;
    assert_eq!(child.stdout, "Created BB-2  Child", "{child:?}");
    let made = t.cli("create --project BB --name Other --labels bug --json").await;
    assert_eq!(keys(&made.json()), ["task", "attachments", "failedAttachments"]);

    let moved = t.agent("update BB-2 --status in_review --json").await;
    assert_match(&moved.json(), &json!({ "task": { "key": "BB-2", "status": "in_review" } }));
    assert!(t.cli("update BB-2").await.stderr.contains("no task changes"));
    let said = t.agent("comment BB-2 --body Done --json").await.json();
    assert_match(&said["comment"], &json!({ "kind": "agent", "threadId": AGENT, "body": "Done" }));
    assert_eq!(said["comment"]["authorName"], json!(format!("agent ({AGENT})")));

    assert_eq!(t.agent("attach BB-2").await.stdout, format!("Attached {AGENT} to BB-2"));
    assert_match(
        &t.cli("threads BB-2 --json").await.json(),
        &json!({ "task": { "key": "BB-2" }, "taskThreads": [{ "threadId": AGENT, "presetName": "Attached" }] }),
    );
    let shown = t.cli("get bb-2 --json").await.json();
    assert_eq!(
        keys(&shown),
        ["task", "project", "labels", "subtasks", "attachments", "taskThreads", "comments"]
    );
    assert!(shown["task"]["parentTaskId"].is_string());
    assert_eq!(shown["task"]["description"], json!("Spec"));
    assert_match(
        &shown["comments"],
        &json!([{}, { "body": "Done", "provider": { "id": "codex" } }]),
    );
    let filtered = t.agent("list --status in_review,done --json").await.json();
    assert_match(
        &filtered,
        &json!({ "tasks": [{ "key": "BB-2", "labels": [] }], "nextCursor": null, "limit": 100 }),
    );
    assert!(filtered["tasks"][0]["agentsWorking"].is_number());
    assert!(t.cli("list").await.stdout.contains("BB-3  backlog"));
    assert_match(
        &t.cli("project list --json").await.json(),
        &json!({ "projects": [{ "prefix": "BB", "linkedBbProjectId": "proj_1" }] }),
    );
    assert_eq!(t.cli(&format!("detach BB-2 --thread {AGENT}")).await.exit_code, 0);
    let missing = t.cli("show BB-99 --json").await;
    let error = json!({ "code": "task_not_found", "message": "task not found: BB-99" });
    assert_eq!((missing.exit_code, missing.json()), (1, json!({ "ok": false, "error": error })));
    t.host.stop().await;
}

#[tokio::test(flavor = "current_thread")]
async fn stores_attachments_over_http_and_through_the_cli_on_both_machines() {
    let t = Tasks::new().await;
    let (_, _, task) = t.seed().await;
    let task_id = task["id"].as_str().unwrap();
    let route = t.host.running("tasks").unwrap().route("POST /attachments/upload").unwrap();
    assert_eq!(route.auth, HttpAuth::Token);
    assert!(!t.host.accepts_token("tasks", None));
    let token = t.host.token("tasks", false).unwrap();
    assert!(t.host.accepts_token("tasks", Some(&token)));

    let query = format!("taskId={task_id}&fileName=..%2Fshot.png&mime=image%2Fpng");
    let (status, _, body) = t.http("POST", "/attachments/upload", &query, &PNG).await;
    let stored: Value = serde_json::from_slice(&body).unwrap();
    let attachment_id = stored["attachmentId"].as_str().unwrap().to_owned();
    let url = stored["url"].as_str().unwrap().to_owned();
    let download = "/api/v1/plugins/tasks/http/attachments/download";
    assert_eq!(
        (status, url.as_str()),
        (201, format!("{download}?attachmentId={attachment_id}").as_str())
    );
    let get_query = format!("attachmentId={attachment_id}");
    let (status, headers, bytes) = t.http("GET", "/attachments/download", &get_query, &[]).await;
    let header = |name: &str| headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone());
    assert_eq!(status, 200);
    assert_eq!(header("content-type").as_deref(), Some("image/png"));
    assert!(header("content-disposition").unwrap().contains("inline"));
    assert_eq!(bytes, PNG);
    let blob = t.data_dir.join("plugins/tasks/blobs").join(&attachment_id).join("shot.png");
    assert_eq!(std::fs::read(blob).unwrap(), PNG);

    let source = t.data_dir.join("report.md");
    std::fs::write(&source, "# Report").unwrap();
    let added = t.cli(&format!("attachment add bb-1 --file {} --json", source.display())).await;
    let added = added.json();
    assert_match(&added["attachment"], &json!({ "fileName": "report.md", "isImage": false }));
    let report_id = added["attachment"]["id"].as_str().unwrap().to_owned();
    let out = t.data_dir.join("nested/copy.md");
    let fetched = t.cli(&format!("attachment get {report_id} --out {}", out.display())).await;
    assert_eq!(fetched.stdout, format!("Saved report.md  {}", out.display()));
    assert_eq!(std::fs::read_to_string(&out).unwrap(), "# Report");

    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD;
    *t.outward.remote_file.lock() = Some(FileRead { content: b64.encode(PNG), sha256: "s".into() });
    let pushed =
        t.cli_in("attachment add BB-1 --file a.png --json", Some(AGENT), Some("/repo/work")).await;
    assert_match(
        &pushed.json(),
        &json!({ "attachment": { "fileName": "a.png", "mime": "image/png", "sizeBytes": 10 } }),
    );
    t.cli_in(&format!("attachment get {report_id} --out ../x.md"), Some(AGENT), Some("/repo/work"))
        .await;
    let reads = t.outward.calls_to("readFile");
    assert!(
        reads.iter().any(|r| r["path"] == "/repo/work/a.png" && r["threadId"] == AGENT),
        "{reads:?}"
    );
    let writes = t.outward.calls_to("writeFile");
    assert_match(
        &json!(writes),
        &json!([{ "path": "/repo/x.md", "content": b64.encode("# Report") }]),
    );

    let description = format!("Before ![shot]({url}) after");
    t.ok("updateTask", json!({ "taskId": task_id, "description": description })).await;
    assert_eq!(t.detail("BB-1").await["attachments"].as_array().unwrap().len(), 3);
    t.ok("deleteAttachment", json!({ "attachmentId": attachment_id })).await;
    let after = t.detail("BB-1").await;
    assert_eq!(after["task"]["description"], json!("Before  after"));
    let remaining: Vec<_> =
        after["attachments"].as_array().unwrap().iter().map(|a| &a["fileName"]).collect();
    assert_eq!(remaining, vec!["report.md", "a.png"]);
    assert_eq!(t.http("GET", "/attachments/download", &get_query, &[]).await.0, 404);
    t.host.stop().await;
}

#[tokio::test(flavor = "current_thread")]
async fn opens_a_database_written_by_the_original_plugin_unchanged() {
    let t = Tasks::new().await;
    let directory = t.data_dir.join("plugins/tasks");
    let [folder, project, task, label] = ["F1", "P1", "T1", "B1"].map(ulid);
    let [comment, file, link, preset] = ["C1", "A1", "X1", "R1"].map(ulid);
    // The plugin's first start wrote the current schema; reopen it the way
    // `initializeTasksSchema` + better-sqlite3 would and insert legacy rows.
    t.host.set_enabled("tasks", false).await.unwrap();
    let legacy = rusqlite::Connection::open(directory.join("data.db")).unwrap();
    legacy
        .execute_batch(&format!(
            "INSERT INTO folders VALUES ('{folder}', 'Work', NULL, 'then');
             INSERT INTO projects VALUES
               ('{project}', 'Legacy', 'OLD', 3, 'steelblue', '{folder}', 'proj_1', 'then');
             INSERT INTO tasks VALUES ('{task}', '{project}', 2, 'Old task', 'Spec',
               'in_review', 'high', '2026-12-24', NULL, 1024, 'then', 'then');
             INSERT INTO labels VALUES ('{label}', '{project}', 'bug', 'indianred');
             INSERT INTO task_labels VALUES ('{task}', '{label}');
             INSERT INTO comments VALUES ('{comment}', '{task}', 'agent', 'agent',
               NULL, 'thr_gone', 'Did it', 0, 'then');
             INSERT INTO attachments VALUES ('{file}', '{task}', NULL, 'note.txt',
               'text/plain', 5, 'blobs/{file}/note.txt', 0, 'then');
             INSERT INTO task_threads VALUES ('{link}', '{task}', 'thr_gone',
               'Attached', 'Old thread', 'idle', 'then', 'then');
             INSERT INTO presets VALUES ('{preset}', 'Codex high', 'codex', 'gpt-5',
               'high', 'full', 'Be careful', 0, 'then', 'new-worktree', 'main', NULL, 'fast');
             INSERT INTO task_key_aliases VALUES ('ZZZ', 9, '{task}');"
        ))
        .unwrap();
    drop(legacy);
    std::fs::create_dir_all(directory.join("blobs").join(&file)).unwrap();
    std::fs::write(directory.join("blobs").join(&file).join("note.txt"), "hello").unwrap();
    t.host.set_enabled("tasks", true).await.unwrap();

    assert_match(
        &t.cli("project list --json").await.json(),
        &json!({ "projects": [{ "prefix": "OLD", "folderId": folder, "nextTaskNumber": 3 }] }),
    );
    assert_match(
        &t.cli("show old-2 --json").await.json(),
        &json!({
            "task": { "key": "OLD-2", "dueDate": "2026-12-24", "labelIds": [label] },
            "labels": [{ "name": "bug" }],
            "attachments": [{ "id": file, "fileName": "note.txt", "sizeBytes": 5 }],
            "taskThreads": [{ "threadId": "thr_gone", "liveStatus": "completed" }],
            "comments": [{ "body": "Did it", "threadTitle": null, "provider": null }],
        }),
    );
    let (_, _, body) =
        t.http("GET", "/attachments/download", &format!("attachmentId={file}"), &[]).await;
    assert_eq!(body, b"hello");
    assert_match(
        &t.cli("preset list --json").await.json(),
        &json!({ "presets": [{ "name": "Codex high", "serviceTier": "fast", "baseBranch": "main" }] }),
    );
    assert_eq!(
        t.cli("create --project old --title 'New task'").await.stdout,
        "Created OLD-3  New task"
    );
    t.cli("update OLD-2 --status done --priority low").await;

    // A second restart on the same data dir runs the migrations again harmlessly.
    t.host.stop().await;
    t.host.reload(None).await.unwrap();
    assert_eq!(t.cli("show OLD-3 --json").await.json()["task"]["title"], json!("New task"));
    t.host.stop().await;

    let stored = rusqlite::Connection::open(directory.join("data.db")).unwrap();
    let column = |sql: &str| {
        stored.query_row(sql, [], |row| row.get::<_, rusqlite::types::Value>(0)).unwrap()
    };
    use rusqlite::types::Value::{Integer, Text};
    assert_eq!(
        [
            column("SELECT due_date FROM tasks WHERE number = 2"),
            column("SELECT folder_id FROM projects"),
            column("SELECT task_id FROM task_key_aliases"),
            column("SELECT COUNT(*) FROM schema_version"),
            column("SELECT revision > 0 FROM task_list_revision"),
        ],
        [Text("2026-12-24".into()), Text(folder), Text(task), Integer(7), Integer(1)]
    );
}

#[tokio::test(flavor = "current_thread")]
async fn dispatches_to_a_new_thread_follows_it_and_notifies_its_agent() {
    let t = Tasks::new().await;
    let (_, _, task) = t.seed().await;
    let saved = t
        .cli("preset set 'Codex high' --provider codex --model gpt-test --reasoning high --permission full --instructions 'Work carefully'")
        .await;
    assert!(saved.stdout.contains("Saved preset Codex high"), "{saved:?}");
    assert!(t.cli("preset set Other").await.stderr.contains("--provider"));
    let dispatched =
        t.cli("dispatch bb-1 --preset 'codex HIGH' --json --instructions 'Be quick'").await.json();
    let thread_id = dispatched["threadId"].as_str().unwrap().to_owned();
    assert_match(
        &dispatched,
        &json!({ "task": { "key": "BB-1" }, "preset": { "name": "Codex high" } }),
    );
    let spawns = t.outward.calls_to("spawn");
    assert_eq!(spawns.len(), 1);
    assert_match(
        &spawns[0],
        &json!({ "projectId": "proj_1", "title": "BB-1 · Fix it", "model": "gpt-test", "permissionMode": "full" }),
    );
    let seed_text = spawns[0]["input"][0]["text"].as_str().unwrap();
    assert!(seed_text.contains("# BB-1 · Fix it\n\n## Task details"), "{seed_text}");
    assert!(seed_text.contains("bb tasks comment BB-1 --body"));
    assert!(seed_text.contains("## Preset instructions\n\nWork carefully"));
    assert!(seed_text.contains("## Additional instructions\n\nBe quick\n"));

    let started = t.detail("BB-1").await;
    assert_eq!(started["task"]["status"], json!("in_progress"));
    assert_match(
        &started["threads"],
        &json!([{ "threadId": thread_id, "presetName": "Codex high" }]),
    );
    let bodies = |d: &Value| {
        d["comments"].as_array().unwrap().iter().map(|c| c["body"].clone()).collect::<Vec<_>>()
    };
    assert_eq!(
        bodies(&started),
        vec![
            json!("Status changed to In Progress · dispatched to Codex high"),
            json!("Dispatched to Codex high")
        ]
    );
    let thread = |status: &str| {
        let mut thread = t.outward.threads.lock()[&thread_id].clone();
        thread["status"] = json!(status);
        t.outward.threads.lock().insert(thread_id.clone(), thread.clone());
        json!({ "thread": thread })
    };
    t.host.emit("thread.active", thread("active"));
    t.eventually_status("working").await;
    t.host.emit("thread.idle", thread("idle"));
    t.eventually_status("idle").await;

    t.cli_in("comment BB-1 --body 'Halfway there'", Some(&thread_id), None).await;
    let reply = json!({ "taskId": task["id"], "body": "Use the new API", "notify": true });
    let comment = t.ok("createComment", reply).await["comment"].clone();
    assert_eq!(comment["notifiedCount"], json!(1));
    let sends = t.outward.calls_to("send");
    let last = sends.last().expect("no steer sent");
    assert_eq!(last["threadId"], json!(thread_id));
    let steer = last["request"]["input"][0]["text"].as_str().unwrap();
    assert!(steer.contains("New comment on task BB-1 from You: Use the new API"), "{steer}");

    t.host.emit("thread.active", thread("active"));
    t.eventually_status("working").await;
    t.host.emit("thread.failed", thread("error"));
    t.eventually_status("failed").await;
    let mut deleted = thread("idle");
    deleted["thread"]["deletedAt"] = json!("2026-10-07T00:00:00.000Z");
    t.host.emit("thread.deleted", deleted);
    t.eventually_status("completed").await;
    let detail = t.detail("BB-1").await;
    let notes = bodies(&detail);
    assert_eq!(
        notes[notes.len() - 2..],
        [
            json!(format!("Thread \"BB-1 · Fix it\" failed · {thread_id}")),
            json!(format!(
                "Thread \"BB-1 · Fix it\" completed — final message posted · {thread_id}"
            )),
        ]
    );
    t.host.stop().await;
}

/// Beyond tasks.test.ts: the header form of the upload route, its size
/// limit and validation, the delete route, download headers for a
/// non-image, realtime channels, and that tasks contributes no agent tools
/// or instructions (agents use `bb tasks`).
#[tokio::test(flavor = "current_thread")]
async fn upload_headers_limits_delete_route_and_realtime_channels() {
    let t = Tasks::new().await;
    let (_, _, task) = t.seed().await;
    let task_id = task["id"].as_str().unwrap();
    let channels: Vec<_> = t
        .socket
        .0
        .lock()
        .iter()
        .filter(|s| s["type"] == "plugin-signal")
        .map(|s| s["channel"].clone())
        .collect();
    assert!(channels.contains(&json!("tasks:changed")), "{channels:?}");
    assert!(channels.contains(&json!("projects:changed")), "{channels:?}");

    let headers =
        [("x-task-id", task_id), ("x-file-name", "a (b).txt"), ("content-type", "text/plain")];
    let (status, _, body) = t.http_with("POST", "/attachments/upload", "", &headers, b"hi").await;
    assert_eq!(status, 201, "{}", String::from_utf8_lossy(&body));
    let id = serde_json::from_slice::<Value>(&body).unwrap()["attachmentId"]
        .as_str()
        .unwrap()
        .to_owned();
    let (status, headers, bytes) =
        t.http("GET", "/attachments/download", &format!("attachmentId={id}"), &[]).await;
    assert_eq!((status, bytes.as_slice()), (200, b"hi".as_slice()));
    let header = |name: &str| headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone());
    assert_eq!(header("content-type").as_deref(), Some("text/plain"));
    assert_eq!(header("content-length").as_deref(), Some("2"));
    assert_eq!(header("x-content-type-options").as_deref(), Some("nosniff"));
    assert_eq!(
        header("content-disposition").as_deref(),
        Some("attachment; filename*=UTF-8''a%20%28b%29.txt")
    );

    let query = format!("taskId={task_id}");
    let (status, _, body) = t.http("POST", "/attachments/upload", &query, b"x").await;
    assert_eq!(
        (status, serde_json::from_slice::<Value>(&body).unwrap()),
        (400, json!({ "error": "fileName is required" }))
    );
    let named = format!("taskId={task_id}&fileName=big.bin&mime=application%2Foctet-stream");
    let declared = [("content-length", "26214401")];
    let (status, _, body) =
        t.http_with("POST", "/attachments/upload", &named, &declared, b"x").await;
    assert_eq!(
        (status, serde_json::from_slice::<Value>(&body).unwrap()),
        (413, json!({ "error": "attachment exceeds the 25 MB limit" }))
    );
    let big = vec![7u8; 25 * 1024 * 1024 + 1];
    let started = std::time::Instant::now();
    let (status, _, body) = t.http("POST", "/attachments/upload", &named, &big).await;
    eprintln!("25 MB + 1 upload: {:?}", started.elapsed());
    assert_eq!(status, 413, "{}", String::from_utf8_lossy(&body));
    let at_limit = vec![7u8; 25 * 1024 * 1024];
    let (status, _, body) = t.http("POST", "/attachments/upload", &named, &at_limit).await;
    assert_eq!(status, 201, "{}", String::from_utf8_lossy(&body));

    let delete = format!("attachmentId={id}");
    let (status, _, body) = t.http("DELETE", "/attachments/delete", &delete, &[]).await;
    assert_eq!(
        (status, serde_json::from_slice::<Value>(&body).unwrap()),
        (200, json!({ "deleted": true }))
    );
    assert_eq!(t.http("DELETE", "/attachments/delete", &delete, &[]).await.0, 404);

    let context = ThreadContext {
        thread_id: AGENT.into(),
        project_id: "proj_1".into(),
        host_id: None,
        provider_id: "codex".into(),
        provider_capabilities: None,
    };
    assert!(t.host.tools_for(&context).await.is_empty());
    assert_eq!(t.host.instructions_for(&context).await, "");
    let unknown = t.host.running("tasks").unwrap().rpc("noSuchMethod").is_none();
    assert!(unknown);
    t.host.stop().await;
}

/// Timing only (`--nocapture`): a typical tasks RPC and CLI call.
#[tokio::test(flavor = "current_thread")]
async fn measure_tasks_rpc_and_cli() {
    let t = Tasks::new().await;
    t.seed().await;
    let runs = 50;
    let started = std::time::Instant::now();
    for _ in 0..runs {
        t.detail("BB-1").await;
    }
    eprintln!("tasks rpc taskDetail: {:?} avg over {runs}", started.elapsed() / runs);
    let started = std::time::Instant::now();
    for _ in 0..runs {
        assert_eq!(t.cli("list --json").await.exit_code, 0);
    }
    eprintln!("tasks cli list --json: {:?} avg over {runs}", started.elapsed() / runs);
    t.host.stop().await;
}
