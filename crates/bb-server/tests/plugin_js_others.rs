use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use bb_core::{ToolCallOutputItem, ToolCallResponse};
use bb_server::config::ServerConfig;
use bb_server::db::Db;
use bb_server::error::ApiResult;
use bb_server::log::{LogLevel, Logger};
use bb_server::plugins::api::*;
use bb_server::plugins::builtin::{BuiltinServer, builtin_plugins};
use bb_server::plugins::host::{PluginHost, PluginHostOptions};
use bb_server::ws::hub::Hub;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Fake {
    inputs: Mutex<Vec<InputRequest>>,
    answers: Mutex<VecDeque<InputResult>>,
    file: Mutex<Option<FileRead>>,
    reads: Mutex<Vec<FileReadArgs>>,
    writes: Mutex<Vec<FileWriteArgs>>,
    write_outcome: Mutex<Option<FileWriteOutcome>>,
}

impl Fake {
    fn answer(&self, result: InputResult) {
        self.answers.lock().unwrap().push_back(result);
    }

    fn existing(&self, content: &str, sha256: &str) {
        let read = FileRead { content: content.into(), sha256: sha256.into() };
        *self.file.lock().unwrap() = Some(read);
    }

    fn inputs(&self) -> Vec<InputRequest> {
        self.inputs.lock().unwrap().clone()
    }

    fn writes(&self) -> Vec<FileWriteArgs> {
        self.writes.lock().unwrap().clone()
    }
}

#[async_trait]
impl PluginOutward for Fake {
    async fn threads_spawn(&self, _: Value) -> ApiResult<Value> {
        Ok(Value::Null)
    }
    async fn threads_send(&self, _: &str, _: Value) -> ApiResult<Value> {
        Ok(Value::Null)
    }
    async fn threads_get(&self, _: &str) -> ApiResult<Option<Value>> {
        Ok(None)
    }
    async fn threads_list(&self, _: Value) -> ApiResult<Value> {
        Ok(json!({ "threads": [] }))
    }
    async fn threads_stop(&self, _: &str) -> ApiResult<()> {
        Ok(())
    }
    async fn threads_update(&self, _: &str, _: Value) -> ApiResult<Value> {
        Ok(Value::Null)
    }
    async fn threads_output(&self, _: &str) -> ApiResult<Option<String>> {
        Ok(None)
    }
    async fn threads_events(&self, _: &str, _: Option<i64>) -> ApiResult<Vec<Value>> {
        Ok(Vec::new())
    }
    async fn projects_list(&self) -> ApiResult<Value> {
        Ok(json!([]))
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
        self.reads.lock().unwrap().push(args);
        Ok(self.file.lock().unwrap().clone())
    }
    async fn files_write(&self, args: FileWriteArgs) -> ApiResult<FileWriteOutcome> {
        self.writes.lock().unwrap().push(args);
        let scripted = self.write_outcome.lock().unwrap().clone();
        Ok(scripted.unwrap_or(FileWriteOutcome::Written { sha256: "new-sha".into() }))
    }
    async fn request_input(&self, request: InputRequest) -> InputResult {
        self.inputs.lock().unwrap().push(request);
        let next = self.answers.lock().unwrap().pop_front();
        next.unwrap_or(InputResult::Cancelled { reason: "unscripted".into() })
    }
}

fn config(root: &Path) -> ServerConfig {
    ServerConfig {
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
    }
}

fn host_with(root: &Path, db: Db, names: &[&str], fake: Arc<Fake>) -> PluginHost {
    let builtins = builtin_plugins()
        .into_iter()
        .filter(|p| names.iter().any(|n| p.directory.ends_with(n)))
        .collect();
    let host = PluginHost::new(PluginHostOptions {
        config: config(root),
        db,
        hub: Hub::new(),
        log: Logger::silent(),
        builtins: Some(builtins),
    });
    host.set_deps(Arc::new(move |_: &str| fake.clone() as Arc<dyn PluginOutward>));
    host
}

async fn started(temp: &tempfile::TempDir, names: &[&str], fake: Arc<Fake>) -> PluginHost {
    assert!(built(), "plugin bundles were not built; run pnpm install");
    let host = host_with(temp.path(), Db::open_in_memory(None).unwrap(), names, fake);
    host.reload(None).await.unwrap();
    host
}

fn built() -> bool {
    builtin_plugins().iter().all(|p| match p.server {
        BuiltinServer::Js(source) => !source.contains("plugin bundle was not built"),
        _ => true,
    })
}

fn context() -> ThreadContext {
    ThreadContext {
        thread_id: "t1".into(),
        project_id: "p1".into(),
        host_id: None,
        provider_id: "codex".into(),
        provider_capabilities: Some(json!({ "supportsNativeUserQuestion": false })),
    }
}

async fn secret(host: &PluginHost, argv: &[&str]) -> CliResult {
    let cli = host.running("secrets").unwrap().cli().expect("secrets registers a CLI");
    let context = CliContext {
        cwd: Some("/work/repo".into()),
        thread_id: Some("t1".into()),
        project_id: Some("p1".into()),
        cancel: CancellationToken::new(),
    };
    cli.run(argv.iter().map(|a| a.to_string()).collect(), context).await
}

fn submitted(values: Value) -> InputResult {
    InputResult::Submitted { value: json!({ "values": values }) }
}

fn cancelled(reason: &str) -> InputResult {
    InputResult::Cancelled { reason: reason.into() }
}

fn ok(stdout: &str) -> CliResult {
    CliResult { exit_code: 0, stdout: stdout.into(), stderr: String::new() }
}

#[tokio::test(flavor = "current_thread")]
async fn secrets_request_writes_a_fresh_dotenv_file() {
    let temp = tempfile::tempdir().unwrap();
    let fake = Arc::new(Fake::default());
    let host = started(&temp, &["secrets"], fake.clone()).await;
    fake.answer(submitted(json!({ "API_KEY": "sk-1", "DB_URL": "it's" })));
    let argv = [
        "request",
        "API_KEY",
        "DB_URL",
        "--write-env",
        ".env",
        "--purpose",
        " Deploy ",
        "--describe",
        "API_KEY",
        "The API key",
    ];
    let result = secret(&host, &argv).await;
    let report = r#"{"path":"/work/repo/.env","names":["API_KEY","DB_URL"],"added":2,"updated":0,"unchanged":0}"#;
    assert_eq!(result, ok(&format!("{report}\n")));

    let inputs = fake.inputs();
    assert_eq!(inputs.len(), 1);
    let input = &inputs[0];
    assert_eq!(input.thread_id, "t1");
    assert_eq!(input.renderer_id, "secret-request");
    assert_eq!(input.title, "Add secrets");
    assert_eq!(input.timeout_ms, Some(600_000));
    assert_eq!(
        input.payload,
        json!({
            "purpose": "Deploy",
            "destination": { "kind": "dotenv", "path": "/work/repo/.env" },
            "fields": [
                { "name": "API_KEY", "description": "The API key" },
                { "name": "DB_URL", "description": null },
            ],
        })
    );
    assert_eq!(
        input.presentation,
        Some(json!({
            "label": {
                "pending": "Requesting API_KEY, DB_URL",
                "completed": "Requested API_KEY, DB_URL",
            },
            "icon": { "glyph": "Lock" },
        }))
    );
    let describe = input.describe_submission.clone().expect("describeSubmission");
    assert_eq!(
        describe(json!({ "values": {} })).await,
        Some(json!({
            "title": "Provided API_KEY, DB_URL",
            "detail": "/work/repo/.env\n- API_KEY\n- DB_URL",
        }))
    );

    let reads = fake.reads.lock().unwrap().clone();
    assert_eq!(reads.len(), 2);
    assert_eq!(reads[0].path, "/work/repo/.env");
    assert_eq!(reads[0].thread_id, "t1");
    let writes = fake.writes();
    assert_eq!(
        writes,
        vec![FileWriteArgs {
            thread_id: "t1".into(),
            path: "/work/repo/.env".into(),
            encoding: None,
            content: "API_KEY='sk-1'\nDB_URL=\"it's\"\n".into(),
            expected_sha256: Some(None),
            mode: Some(0o600),
        }]
    );
    host.stop().await;
}

#[tokio::test(flavor = "current_thread")]
async fn secrets_request_merges_into_an_existing_dotenv_file() {
    let temp = tempfile::tempdir().unwrap();
    let fake = Arc::new(Fake::default());
    let host = started(&temp, &["secrets"], fake.clone()).await;
    let existing = "# config\r\nexport API_KEY=old # rotate monthly\r\nOTHER=1\r\nSAME='v'\r\n";
    fake.existing(existing, "abc123");
    fake.answer(submitted(json!({ "API_KEY": "new", "SAME": "v", "NEW": "a'b\"c" })));
    let argv = ["request", "API_KEY", "SAME", "NEW", "--write-env=config/.env"];
    let result = secret(&host, &argv).await;
    let report = r#"{"path":"/work/repo/config/.env","names":["API_KEY","SAME","NEW"],"added":1,"updated":1,"unchanged":1}"#;
    assert_eq!(result, ok(&format!("{report}\n")));
    assert_eq!(fake.inputs()[0].payload["purpose"], Value::Null);
    let writes = fake.writes();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0].content,
        "# config\r\nexport API_KEY='new' # rotate monthly\r\nOTHER=1\r\nSAME='v'\r\nNEW=a'b\"c\r\n"
    );
    assert_eq!(writes[0].expected_sha256, Some(Some("abc123".into())));
    assert_eq!(writes[0].mode, Some(0o600));
    host.stop().await;
}

#[tokio::test(flavor = "current_thread")]
async fn secrets_request_reports_conflicts_cancellation_and_bad_input() {
    let temp = tempfile::tempdir().unwrap();
    let fake = Arc::new(Fake::default());
    let host = started(&temp, &["secrets"], fake.clone()).await;
    let argv = ["request", "API_KEY", "--write-env", ".env"];

    *fake.write_outcome.lock().unwrap() = Some(FileWriteOutcome::Conflict);
    fake.answer(submitted(json!({ "API_KEY": "x" })));
    let conflict = secret(&host, &argv).await;
    assert_eq!(conflict.exit_code, 1);
    assert!(conflict.stdout.is_empty());
    assert_eq!(conflict.stderr, "The dotenv file changed mid-write; run the request again.\n");

    fake.answer(cancelled("dismissed"));
    let dismissed = secret(&host, &argv).await;
    assert_eq!(dismissed.exit_code, 1);
    assert_eq!(dismissed.stderr, "Secret request cancelled (dismissed).\n");

    fake.answer(cancelled("timeout"));
    let timed_out = secret(&host, &argv).await;
    assert_eq!(timed_out.exit_code, 1);
    assert_eq!(timed_out.stderr, "Secret request cancelled (timeout).\n");
    assert!(fake.inputs().iter().all(|i| i.timeout_ms == Some(600_000)));

    fake.answer(submitted(json!({ "OTHER": "x" })));
    let mismatch = secret(&host, &argv).await;
    assert_eq!(mismatch.stderr, "The form did not return exactly the requested names.\n");

    let json_argv = ["request", "API_KEY", "--write-env", ".env", "--json"];
    fake.answer(cancelled("dismissed"));
    let as_json = secret(&host, &json_argv).await;
    let body = json!({ "ok": false, "error": {
        "code": "cancelled", "message": "Secret request cancelled (dismissed).",
    } });
    assert_eq!(
        as_json,
        CliResult {
            exit_code: 1,
            stdout: format!("{}\n", serde_json::to_string_pretty(&body).unwrap()),
            stderr: "Secret request cancelled (dismissed).\n".into(),
        }
    );

    let inputs_before = fake.inputs().len();
    let invalid = secret(&host, &["request", "1BAD", "--write-env", ".env"]).await;
    assert_eq!(invalid.exit_code, 1);
    assert_eq!(invalid.stderr, "Names must be unique and match [A-Za-z_][A-Za-z0-9_]*.\n");
    fake.existing("A=1\nA=2\n", "s");
    let twice = secret(&host, &["request", "A", "--write-env", ".env"]).await;
    assert_eq!(twice.stderr, "The dotenv file assigns A more than once.\n");
    assert_eq!(fake.inputs().len(), inputs_before);
    assert_eq!(fake.writes().len(), 1);
    host.stop().await;
}

async fn rpc(host: &PluginHost, method: &str, input: Value) -> Result<Value, RpcFailure> {
    let handler = host.running("thread-list").unwrap().rpc(method).expect(method);
    handler.call(input).await
}

#[tokio::test(flavor = "current_thread")]
async fn thread_list_preferences_persist_in_kv_across_restarts() {
    let temp = tempfile::tempdir().unwrap();
    let db_path = temp.path().join("bb.db");
    let fake = Arc::new(Fake::default());
    let host =
        host_with(temp.path(), Db::open(&db_path, None).unwrap(), &["thread-list"], fake.clone());
    host.reload(None).await.unwrap();

    let defaults = rpc(&host, "listPreferences", Value::Null).await.unwrap();
    assert_eq!(
        defaults,
        json!({ "preferences": {
            "showProviderIcons": false,
            "threadLifecycles": ["active"],
            "environmentGrouping": "auto",
            "chronologicalSort": "updated",
            "sortDirection": "default",
            "manualSectionOrder": ["pinned", "sections", "threads"],
            "collapsedSections": [],
            "collapsedThreads": [],
            "collapsedEnvironments": [],
            "collapsedThreadSections": [],
        } })
    );
    let change = json!({ "key": "chronologicalSort", "value": "alpha" });
    assert_eq!(rpc(&host, "setPreference", change.clone()).await.unwrap(), change);
    let change = json!({ "key": "collapsedThreads", "value": ["thr_1"] });
    assert_eq!(rpc(&host, "setPreference", change.clone()).await.unwrap(), change);
    let bad = rpc(&host, "setPreference", json!({ "key": "sortDirection", "value": "up" })).await;
    assert!(bad.is_err(), "{bad:?}");
    let unknown = rpc(&host, "setPreference", json!({ "key": "nope", "value": 1 })).await;
    assert_eq!(unknown.unwrap_err().code, RpcErrorCode::InvalidInput);

    host.reload(Some("thread-list")).await.unwrap();
    let after = rpc(&host, "listPreferences", Value::Null).await.unwrap();
    assert_eq!(after["preferences"]["chronologicalSort"], json!("alpha"));
    assert_eq!(after["preferences"]["collapsedThreads"], json!(["thr_1"]));
    host.stop().await;
    drop(host);

    let sqlite = rusqlite::Connection::open(&db_path).unwrap();
    let stored: String = sqlite
        .query_row(
            "SELECT value FROM plugin_kv WHERE plugin_id = 'thread-list' AND key = ?1",
            ["preference:chronologicalSort"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stored, "\"alpha\"");
    sqlite
        .execute(
            "INSERT INTO plugin_kv (plugin_id, key, value, updated_at) \
             VALUES ('thread-list', 'preference:showProviderIcons', '\"yes\"', 0)",
            [],
        )
        .unwrap();
    drop(sqlite);

    let reopened =
        host_with(temp.path(), Db::open(&db_path, None).unwrap(), &["thread-list"], fake);
    reopened.reload(None).await.unwrap();
    let again = rpc(&reopened, "listPreferences", Value::Null).await.unwrap();
    assert_eq!(again["preferences"]["chronologicalSort"], json!("alpha"));
    assert_eq!(again["preferences"]["collapsedThreads"], json!(["thr_1"]));
    assert_eq!(again["preferences"]["showProviderIcons"], json!(false));
    reopened.stop().await;
}

fn text_of(response: &ToolCallResponse) -> String {
    match response.content_items.as_slice() {
        [ToolCallOutputItem::InputText { text }] => text.clone(),
        other => panic!("unexpected tool output {other:?}"),
    }
}

async fn ask(host: &PluginHost, input: Value) -> ToolCallResponse {
    host.call_tool("AskUserQuestion", input, context(), CancellationToken::new()).await
}

fn option(label: &str, description: &str) -> Value {
    json!({ "label": label, "description": description })
}

#[tokio::test(flavor = "current_thread")]
async fn ask_user_question_single_question_round_trip() {
    let temp = tempfile::tempdir().unwrap();
    let fake = Arc::new(Fake::default());
    let host = started(&temp, &["ask-user-question"], fake.clone()).await;
    let question = json!({
        "question": "Which library?",
        "header": "Library",
        "options": [
            { "label": "date-fns", "description": "Small", "preview": "  import x  " },
            option("luxon", "Zones"),
        ],
    });
    fake.answer(InputResult::Submitted {
        value: json!({ "answers": { "q0": { "selected": ["q0o0"], "freeText": "pin v3" } } }),
    });
    let response = ask(&host, json!({ "questions": [question.clone()] })).await;
    assert!(response.success);
    let answered: Value = serde_json::from_str(&text_of(&response)).unwrap();
    assert_eq!(
        answered,
        json!({
            "questions": [question],
            "answers": { "Which library?": "date-fns; pin v3" },
            "annotations": { "Which library?": { "preview": "import x", "notes": "pin v3" } },
        })
    );

    let input = &fake.inputs()[0];
    assert_eq!(input.thread_id, "t1");
    assert_eq!(input.renderer_id, "ask-user-question");
    assert_eq!(input.title, "Library");
    assert_eq!(input.timeout_ms, Some(1_800_000));
    assert_eq!(
        input.payload,
        json!({ "questions": [{
            "id": "q0",
            "prompt": "Which library?",
            "shortLabel": "Library",
            "multiSelect": false,
            "allowFreeText": true,
            "options": [
                { "value": "q0o0", "label": "date-fns", "description": "Small", "preview": "import x" },
                { "value": "q0o1", "label": "luxon", "description": "Zones" },
            ],
        }] })
    );
    assert_eq!(
        input.presentation,
        Some(json!({
            "label": { "pending": "Asking a question", "completed": "Asked" },
            "icon": { "glyph": "MessageQuestion" },
        }))
    );
    let describe = input.describe_submission.clone().expect("describeSubmission");
    let value = json!({ "answers": { "q0": { "selected": ["q0o1"] } } });
    assert_eq!(
        describe(value).await,
        Some(json!({
            "title": "Answered Which library? — luxon",
            "detail": "- Which library? — luxon",
        }))
    );

    fake.answer(InputResult::Submitted {
        value: json!({ "answers": { "q0": { "selected": [], "freeText": "moment" } } }),
    });
    let freeform = ask(&host, json!({ "questions": [question] })).await;
    let freeform: Value = serde_json::from_str(&text_of(&freeform)).unwrap();
    assert_eq!(freeform["answers"], json!({ "Which library?": "moment" }));
    assert_eq!(freeform["response"], json!("moment"));
    assert!(freeform.get("annotations").is_none());
    host.stop().await;
}

#[tokio::test(flavor = "current_thread")]
async fn ask_user_question_multiple_questions_and_multi_select() {
    let temp = tempfile::tempdir().unwrap();
    let fake = Arc::new(Fake::default());
    let host = started(&temp, &["ask-user-question"], fake.clone()).await;
    let questions = json!([
        {
            "question": "Which features?",
            "header": "Features",
            "multiSelect": true,
            "options": [
                { "label": "Auth", "description": "Login", "preview": "hidden" },
                option("Billing", "Stripe"),
                option("Search", "Full text"),
            ],
        },
        { "question": "Which DB?", "header": "DB", "options": [option("PG", "Postgres"), option("SQLite", "File")] },
    ]);
    fake.answer(InputResult::Submitted {
        value: json!({ "answers": { "q0": { "selected": ["q0o0", "q0o2"] } } }),
    });
    let response = ask(&host, json!({ "questions": questions.clone() })).await;
    assert!(response.success);
    let answered: Value = serde_json::from_str(&text_of(&response)).unwrap();
    assert_eq!(
        answered,
        json!({ "questions": questions, "answers": { "Which features?": "Auth, Search" } })
    );
    let input = &fake.inputs()[0];
    assert_eq!(input.title, "2 questions");
    assert_eq!(input.payload["questions"][0]["multiSelect"], json!(true));
    assert!(input.payload["questions"][0]["options"][0].get("preview").is_none());
    assert_eq!(input.payload["questions"][1]["id"], json!("q1"));
    let describe = input.describe_submission.clone().unwrap();
    let value = json!({ "answers": { "q0": { "selected": ["q0o1"] } } });
    assert_eq!(
        describe(value).await,
        Some(json!({
            "title": "Answered 1 of 2 questions",
            "detail": "- Which features? — Billing\n- Which DB? — no answer",
        }))
    );
    host.stop().await;
}

#[tokio::test(flavor = "current_thread")]
async fn ask_user_question_cancellation_and_rejections() {
    let temp = tempfile::tempdir().unwrap();
    let fake = Arc::new(Fake::default());
    let host = started(&temp, &["ask-user-question"], fake.clone()).await;
    let input = json!({ "questions": [{
        "question": "Go?", "header": "Go", "options": [option("Yes", "y"), option("No", "n")],
    }] });
    let advice = "Proceed with your best judgement, or ask again in your reply.";

    fake.answer(cancelled("dismissed"));
    let dismissed = ask(&host, input.clone()).await;
    assert!(!dismissed.success);
    assert_eq!(text_of(&dismissed), format!("The user dismissed the question. {advice}"));

    fake.answer(cancelled("timeout"));
    let timed_out = ask(&host, input.clone()).await;
    assert!(!timed_out.success);
    assert_eq!(text_of(&timed_out), format!("The user did not answer the question. {advice}"));

    fake.answer(InputResult::Submitted { value: json!({ "answers": {} }) });
    let empty = ask(&host, input).await;
    assert!(!empty.success);
    assert_eq!(text_of(&empty), format!("The user submitted no answers. {advice}"));

    let one = json!({ "questions": [{ "question": "Go?", "header": "Go", "options": [option("Yes", "y")] }] });
    let rejected = ask(&host, one).await;
    assert!(!rejected.success);
    let text = text_of(&rejected);
    assert!(text.starts_with("Invalid arguments: "), "{text}");
    assert!(text.contains("fewer than 2 options"), "{text}");
    assert_eq!(fake.inputs().len(), 3);
    host.stop().await;
}

fn rss_kib() -> u64 {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    status
        .lines()
        .find_map(|line| line.strip_prefix("VmRSS:"))
        .and_then(|rest| rest.trim().trim_end_matches("kB").trim().parse().ok())
        .unwrap_or(0)
}

#[tokio::test(flavor = "current_thread")]
async fn measure_all_five() {
    assert!(built(), "plugin bundles were not built; run pnpm install");
    let five = ["tasks", "secrets", "thread-list", "ask-user-question", "custom-instructions"];
    for plugin in builtin_plugins() {
        if let BuiltinServer::Js(source) = plugin.server {
            eprintln!("bundle {}: {} bytes", plugin.directory.display(), source.len());
        }
    }
    let rss_start = rss_kib();
    for name in five {
        let temp = tempfile::tempdir().unwrap();
        let host =
            host_with(temp.path(), Db::open_in_memory(None).unwrap(), &[name], Arc::default());
        let start = Instant::now();
        host.reload(None).await.unwrap();
        let elapsed = start.elapsed();
        host.running(name).unwrap();
        eprintln!("start {name}: {elapsed:?}");
        host.stop().await;
    }

    let temp = tempfile::tempdir().unwrap();
    let fake = Arc::new(Fake::default());
    let rss_before = rss_kib();
    let host = host_with(temp.path(), Db::open_in_memory(None).unwrap(), &five, fake.clone());
    let start = Instant::now();
    host.reload(None).await.unwrap();
    eprintln!("start all five: {:?}", start.elapsed());
    let rss_loaded = rss_kib();

    let calls = 50u32;
    let start = Instant::now();
    for _ in 0..calls {
        rpc(&host, "listPreferences", Value::Null).await.unwrap();
    }
    let per_rpc = start.elapsed() / calls;
    let cli_argv = ["request", "1BAD", "--write-env", ".env"];
    let start = Instant::now();
    for _ in 0..calls {
        assert_eq!(secret(&host, &cli_argv).await.exit_code, 1);
    }
    let per_cli = start.elapsed() / calls;
    let start = Instant::now();
    for _ in 0..calls {
        fake.answer(submitted(json!({ "API_KEY": "x" })));
        let argv = ["request", "API_KEY", "--write-env", ".env"];
        assert_eq!(secret(&host, &argv).await.exit_code, 0);
    }
    let per_full_cli = start.elapsed() / calls;
    let rss_after_calls = rss_kib();
    eprintln!("rpc thread-list listPreferences: {per_rpc:?} avg over {calls}");
    eprintln!("cli secret request (validation failure): {per_cli:?} avg over {calls}");
    eprintln!("cli secret request (full flow): {per_full_cli:?} avg over {calls}");
    eprintln!(
        "VmRSS: process start {rss_start} KiB, before host {rss_before} KiB, \
         all five loaded {rss_loaded} KiB (+{} KiB), after calls {rss_after_calls} KiB",
        rss_loaded.saturating_sub(rss_before)
    );
    host.stop().await;
    assert!(per_rpc < Duration::from_secs(1));
}
