use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use axum::Router;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Path, Query, State};
use axum::response::Response;
use axum::routing::get;
use bb_core::{
    Lane, RunnerApi, RunnerError, RunnerErrorCode, RunnerEvent, RunnerEventBody, RunnerEventSink,
    RunnerResult, SharedRunner,
};
use bb_server::config::ServerConfig;
use bb_server::context::{Ctx, ServerContext};
use bb_server::db::Db;
use bb_server::db::hosts::{NewHost, insert_host};
use bb_server::domain::host::MachinePhase;
use bb_server::domain::terminal::{TerminalSessionCloseReason, TerminalSessionStatus};
use bb_server::log::{LogLevel, Logger};
use bb_server::plugins::host::{PluginHost, PluginHostOptions};
use bb_server::runners::registry::RunnerRegistry;
use bb_server::terminals::sessions::{
    CloseTerminalMode, CloseTerminalRequest, CreateTerminalRequest, LaunchTarget,
    TerminalCreateTarget, attach_terminal_socket, close_terminal, close_terminals_for,
    launch_terminal, require_terminal, start_terminal_sessions,
};
use bb_server::ws::hub::Hub;
use futures::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

const HOST: &str = "host_local";

#[derive(Default)]
struct FakeState {
    calls: Vec<(String, Value)>,
    output: HashMap<String, Vec<String>>,
    terminal_ids: Vec<String>,
    sink: Option<RunnerEventSink>,
}

#[derive(Clone, Default)]
struct FakeRunner(Arc<Mutex<FakeState>>);

#[async_trait]
impl RunnerApi for FakeRunner {
    async fn call(&self, method: &str, params: Value) -> RunnerResult<Value> {
        let mut state = self.0.lock();
        state.calls.push((method.to_owned(), params.clone()));
        let terminal_id = params["terminalId"].as_str().unwrap_or_default().to_owned();
        Ok(match method {
            "openTerminal" => {
                state.terminal_ids.push(terminal_id);
                json!({ "shell": "/bin/zsh", "title": "zsh", "initialCwd": params["cwd"],
                    "cols": params["cols"], "rows": params["rows"] })
            }
            "attachTerminal" => {
                let Some(output) = state.output.get(&terminal_id) else {
                    let code = RunnerErrorCode::TerminalNotFound;
                    return Err(RunnerError::new(code, "Terminal not found"));
                };
                let since = params["sinceSeq"].as_u64().unwrap_or(0) as usize;
                let chunks: Vec<Value> = output
                    .iter()
                    .enumerate()
                    .skip(since)
                    .map(|(seq, data)| json!({ "seq": seq, "dataBase64": data }))
                    .collect();
                json!({ "chunks": chunks, "replayStartSeq": since.min(output.len()),
                    "nextSeq": output.len(), "exited": null })
            }
            "snapshot" => json!({ "sessions": [], "pendingRequestIds": [],
                "terminalIds": state.terminal_ids, "lastEventSeq": 0 }),
            _ => Value::Null,
        })
    }
}

impl FakeRunner {
    fn connect(&self, ctx: &Ctx) {
        let fake = self.clone();
        ctx.runners.connect(
            HOST,
            Box::new(move |sink| {
                fake.0.lock().sink = Some(sink);
                Arc::new(fake) as SharedRunner
            }),
        );
    }

    fn emit(&self, body: RunnerEventBody, seq: Option<u64>) {
        let sink = self.0.lock().sink.clone().unwrap();
        sink(RunnerEvent { lane: Lane::Live, seq, body });
    }

    fn output(&self, terminal_id: &str, data: &str) -> u64 {
        let seq = {
            let mut state = self.0.lock();
            let output = state.output.entry(terminal_id.to_owned()).or_default();
            output.push(data.to_owned());
            output.len() as u64 - 1
        };
        let body = RunnerEventBody::TerminalOutput {
            terminal_id: terminal_id.to_owned(),
            data_base64: data.to_owned(),
        };
        self.emit(body, Some(seq));
        seq
    }

    fn calls(&self, method: &str) -> Vec<Value> {
        let state = self.0.lock();
        state.calls.iter().filter(|(name, _)| name == method).map(|(_, p)| p.clone()).collect()
    }
}

fn context() -> Ctx {
    let dir = std::env::temp_dir();
    let config = ServerConfig {
        data_dir: dir.clone(),
        port: 0,
        bind_host: "127.0.0.1".into(),
        allowed_hosts: Vec::new(),
        app_dir: dir.clone(),
        cli_dir: dir.clone(),
        bb_cli_path: dir,
        version: "0.0.0".into(),
        host_id: HOST.into(),
        log_level: LogLevel::Silent,
    };
    let db = Db::open_in_memory(None).unwrap();
    db.run("PRAGMA foreign_keys = OFF", []).unwrap();
    let host = NewHost {
        id: HOST.into(),
        name: "Local".into(),
        phase: MachinePhase::Active,
        status_message: None,
        launch_key: None,
    };
    insert_host(&db, &host).unwrap();
    let hub = Hub::new();
    let log = Logger::silent();
    let plugins = PluginHost::new(PluginHostOptions {
        config: config.clone(),
        db: db.clone(),
        hub: hub.clone(),
        log: log.clone(),
        builtins: Some(Vec::new()),
    });
    Arc::new(ServerContext {
        config,
        db,
        hub,
        runners: RunnerRegistry::new(HOST, log.clone()),
        plugins,
        log,
        engine: Default::default(),
        environments: Default::default(),
        terminals: Default::default(),
    })
}

async fn open(ctx: &Ctx) -> String {
    let target = LaunchTarget {
        thread_id: Some("thr_demo".into()),
        environment_id: None,
        host_id: HOST.into(),
        project_id: None,
        cwd: Some("/work".into()),
    };
    let payload = CreateTerminalRequest {
        cols: 80,
        rows: 24,
        start: None,
        target: TerminalCreateTarget::Thread { thread_id: "thr_demo".into() },
        title: None,
    };
    let env = async { Ok(BTreeMap::from([("BB".to_owned(), "1".to_owned())])) };
    let session = launch_terminal(ctx, target, payload, env).await.unwrap();
    assert_eq!(session.status, TerminalSessionStatus::Running);
    assert_eq!(session.title, "zsh");
    session.id
}

async fn ws_route(
    State(ctx): State<Ctx>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    upgrade: WebSocketUpgrade,
) -> Response {
    let since = query.get("sinceSeq").and_then(|seq| seq.parse().ok()).unwrap_or(0);
    upgrade.on_upgrade(move |socket| attach_terminal_socket(ctx, id, since, socket))
}

async fn serve(ctx: &Ctx) -> u16 {
    let app = Router::new().route("/ws/terminals/{id}", get(ws_route)).with_state(ctx.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    port
}

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn attach(port: u16, id: &str, since: u64) -> Socket {
    let url = format!("ws://127.0.0.1:{port}/ws/terminals/{id}?sinceSeq={since}");
    connect_async(url).await.unwrap().0
}

async fn next(socket: &mut Socket) -> Value {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .expect("frame in time")
            .unwrap()
            .unwrap();
        if let Message::Text(text) = message {
            return serde_json::from_str(text.as_str()).unwrap();
        }
    }
}

async fn next_of(socket: &mut Socket, kind: &str) -> Value {
    loop {
        let frame = next(socket).await;
        if frame["type"] == kind {
            return frame;
        }
    }
}

async fn send(socket: &mut Socket, message: Value) {
    socket.send(Message::Text(message.to_string().into())).await.unwrap();
}

async fn settle() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    tokio::time::sleep(Duration::from_millis(20)).await;
}

#[tokio::test]
async fn runs_terminals_through_attach_replay_exit_and_a_lost_machine() {
    let ctx = context();
    let fake = FakeRunner::default();
    fake.connect(&ctx);
    let _guard = start_terminal_sessions(&ctx).unwrap();
    let port = serve(&ctx).await;

    let id = open(&ctx).await;
    let opened = &fake.calls("openTerminal")[0];
    assert_eq!(opened["cwd"], "/work");
    assert_eq!(opened["env"], json!({ "BB": "1" }));
    assert_eq!(opened["start"], json!({ "mode": "shell" }));
    fake.0.lock().output.insert(id.clone(), Vec::new());

    let mut first = attach(port, &id, 0).await;
    let attached = next(&mut first).await;
    assert_eq!(attached["type"], "attached");
    assert_eq!(attached["session"]["status"], "running");
    fake.output(&id, "YQ==");
    fake.output(&id, "Yg==");
    assert_eq!(
        next(&mut first).await,
        json!({ "type": "output", "chunk": { "seq": 0, "dataBase64": "YQ==" } })
    );
    assert_eq!(next_of(&mut first, "output").await["chunk"]["seq"], 1);

    send(&mut first, json!({ "type": "input", "dataBase64": "bHM=" })).await;
    send(&mut first, json!({ "type": "resize", "cols": 100, "rows": 30 })).await;
    let updated = next_of(&mut first, "session-updated").await;
    assert!(updated["session"]["lastUserInputAt"].is_number());
    let resized = next_of(&mut first, "session-updated").await;
    assert_eq!(
        (resized["session"]["cols"].clone(), resized["session"]["rows"].clone()),
        (json!(100), json!(30))
    );
    send(&mut first, json!({ "type": "ping" })).await;
    assert_eq!(next_of(&mut first, "pong").await, json!({ "type": "pong" }));
    assert_eq!(fake.calls("writeTerminal")[0]["dataBase64"], "bHM=");

    let mut second = attach(port, &id, 1).await;
    let replayed = next(&mut second).await;
    assert_eq!(
        (replayed["replayStartSeq"].clone(), replayed["nextSeq"].clone()),
        (json!(1), json!(2))
    );
    assert_eq!(next(&mut second).await["chunk"]["seq"], 1);
    send(&mut first, json!({ "type": "resize", "cols": 90, "rows": 30 })).await;
    fake.output(&id, "Yw==");
    assert_eq!(next_of(&mut first, "output").await["chunk"]["seq"], 2);
    assert_eq!(next_of(&mut second, "output").await["chunk"]["seq"], 2);
    assert_eq!(require_terminal(&ctx, &id).unwrap().cols, 100);
    send(&mut second, json!({ "type": "bogus" })).await;
    assert_eq!(next_of(&mut second, "error").await["code"], "invalid_message");

    let mut unknown = attach(port, "term_none", 0).await;
    let missing = next(&mut unknown).await;
    assert_eq!(
        missing,
        json!({ "type": "error", "code": "terminal_not_found", "message": "Terminal session not found" })
    );

    let exit = RunnerEventBody::TerminalExited { terminal_id: id.clone(), exit_code: Some(0) };
    fake.emit(exit, None);
    let farewell = next_of(&mut first, "exited").await;
    assert_eq!(farewell["session"]["status"], "exited");
    assert_eq!(farewell["session"]["exitCode"], 0);
    assert_eq!(farewell["session"]["closeReason"], "process-exit");
    send(&mut first, json!({ "type": "input", "dataBase64": "bHM=" })).await;
    assert_eq!(next_of(&mut first, "error").await["code"], "terminal_not_running");
    let mut late = attach(port, &id, 5).await;
    assert_eq!(next(&mut late).await["replayStartSeq"], 0);
    assert_eq!(next(&mut late).await["type"], "exited");

    let held_id = open(&ctx).await;
    fake.0.lock().output.insert(held_id.clone(), Vec::new());
    let mut held = attach(port, &held_id, 0).await;
    next_of(&mut held, "attached").await;
    ctx.runners.disconnect(HOST, None);
    assert_eq!(next_of(&mut held, "session-updated").await["session"]["status"], "disconnected");
    fake.connect(&ctx);
    assert_eq!(next_of(&mut held, "session-updated").await["session"]["status"], "running");
    fake.output(&held_id, "ZA==");
    assert_eq!(next_of(&mut held, "output").await["chunk"]["dataBase64"], "ZA==");

    let force = CloseTerminalRequest {
        mode: CloseTerminalMode::Force,
        reason: TerminalSessionCloseReason::User,
    };
    let closed = close_terminal(&ctx, &held_id, &force).unwrap();
    assert_eq!(closed.close_reason, Some(TerminalSessionCloseReason::User));
    settle().await;
    assert_eq!(fake.calls("closeTerminal").last().unwrap()["terminalId"], held_id.as_str());

    let dirty = open(&ctx).await;
    fake.0.lock().output.insert(dirty.clone(), Vec::new());
    let session = require_terminal(&ctx, &dirty).unwrap();
    bb_server::terminals::sessions::write_terminal_input(&ctx, &session, "bHM=").await.unwrap();
    let clean = CloseTerminalRequest { mode: CloseTerminalMode::IfClean, ..force };
    assert_eq!(
        close_terminal(&ctx, &dirty, &clean).unwrap().status,
        TerminalSessionStatus::Running
    );

    ctx.runners.disconnect(HOST, None);
    let replacement = FakeRunner::default();
    replacement.connect(&ctx);
    settle().await;
    let lost = require_terminal(&ctx, &dirty).unwrap();
    assert_eq!(lost.status, TerminalSessionStatus::Exited);
    assert_eq!(lost.close_reason, Some(TerminalSessionCloseReason::DaemonDisconnect));

    let doomed = open(&ctx).await;
    close_terminals_for(&ctx, "thread_id", "thr_demo", "thread-archived");
    let archived = require_terminal(&ctx, &doomed).unwrap();
    assert_eq!(archived.status, TerminalSessionStatus::Exited);
    assert_eq!(archived.close_reason, Some(TerminalSessionCloseReason::ThreadArchived));
}

#[tokio::test]
async fn reads_output_pages_and_refuses_lost_terminals() {
    use bb_server::terminals::sessions::{TerminalOutputQuery, read_terminal_output};
    let ctx = context();
    let fake = FakeRunner::default();
    fake.connect(&ctx);
    let _guard = start_terminal_sessions(&ctx).unwrap();
    let id = open(&ctx).await;
    fake.0.lock().output.insert(id.clone(), Vec::new());
    for data in ["YQ==", "Yg==", "Yw=="] {
        fake.output(&id, data);
    }
    let query = TerminalOutputQuery { since_seq: Some(1), tail_bytes: None, limit_chunks: None };
    let page = read_terminal_output(&ctx, &id, query).await.unwrap();
    let body = serde_json::to_value(&page).unwrap();
    assert_eq!(
        body,
        json!({ "chunks": [{ "seq": 1, "dataBase64": "Yg==" }, { "seq": 2, "dataBase64": "Yw==" }],
            "nextSeq": 3, "truncated": false, "status": "running", "exitCode": null,
            "closeReason": null })
    );
    let limited = TerminalOutputQuery { limit_chunks: Some(1), ..TerminalOutputQuery::default() };
    let page = read_terminal_output(&ctx, &id, limited).await.unwrap();
    assert_eq!((page.chunks.len(), page.chunks[0].seq, page.truncated), (1, 2, true));

    fake.0.lock().output.remove(&id);
    let error = read_terminal_output(&ctx, &id, TerminalOutputQuery::default()).await.unwrap_err();
    assert_eq!(error.body.code, "terminal_output_unavailable");
    assert_eq!(error.body.message, "The machine no longer holds this terminal's output");

    ctx.runners.disconnect(HOST, None);
    let error = read_terminal_output(&ctx, &id, TerminalOutputQuery::default()).await.unwrap_err();
    assert_eq!(error.body.message, "Terminal output can only be read once it has started");
}

#[tokio::test]
async fn a_running_terminal_whose_output_is_gone_is_closed_on_attach() {
    let ctx = context();
    let fake = FakeRunner::default();
    fake.connect(&ctx);
    let _guard = start_terminal_sessions(&ctx).unwrap();
    let port = serve(&ctx).await;
    let id = open(&ctx).await;
    let mut socket = attach(port, &id, 0).await;
    let frame = next_of(&mut socket, "error").await;
    assert_eq!(frame["code"], "terminal_not_found");
    let session = require_terminal(&ctx, &id).unwrap();
    assert_eq!(session.close_reason, Some(TerminalSessionCloseReason::DaemonDisconnect));
}

#[test]
fn parses_client_messages_within_the_contract_limits() {
    use bb_server::terminals::sessions::TerminalClientMessage as M;
    assert_eq!(M::parse(r#"{"type":"ping"}"#), Some(M::Ping {}));
    assert_eq!(
        M::parse(r#"{"type":"resize","cols":500,"rows":200}"#),
        Some(M::Resize { cols: 500, rows: 200 })
    );
    assert_eq!(M::parse(r#"{"type":"resize","cols":501,"rows":20}"#), None);
    assert_eq!(M::parse(r#"{"type":"resize","cols":0,"rows":20}"#), None);
    assert_eq!(M::parse(r#"{"type":"input","dataBase64":"!!"}"#), None);
    assert_eq!(M::parse(r#"{"type":"input","dataBase64":""}"#), None);
    assert_eq!(M::parse(r#"{"type":"ping","extra":1}"#), None);
}
