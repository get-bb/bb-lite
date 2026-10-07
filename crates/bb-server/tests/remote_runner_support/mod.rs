//! A real in-process server on port 0 with a controllable clock, a TCP relay that can sever
//! every connection through it, and a real remote runner enrolled through that relay.

#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{Duration, Instant};

use bb_core::{RunnerEvent, RunnerEventBody, SharedRunner};
use bb_remote::{JoinOptions, RunOptions, RunningRunner, join_server, run_runner};
use bb_server::config::{ServerEnv, load_config};
use bb_server::runners::local::{LocalRunnerHandle, local_runner_for};
use bb_server::server::{BbServer, CreateServerOptions};
use parking_lot::Mutex;
use reqwest::StatusCode;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::task::JoinHandle;

pub const START: i64 = 1_700_000_000_000;

pub async fn until<T>(mut read: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(value) = read() {
            return value;
        }
        assert!(Instant::now() < deadline, "condition not reached");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

pub struct TestServer {
    pub server: BbServer,
    pub url: String,
    pub clock: Arc<AtomicI64>,
    pub http: reqwest::Client,
    local: LocalRunnerHandle,
    _dirs: TempDir,
}

impl TestServer {
    pub async fn start() -> Self {
        let dirs = tempfile::tempdir().unwrap();
        let path = |name: &str| dirs.path().join(name).to_string_lossy().into_owned();
        std::fs::create_dir_all(dirs.path().join("app")).unwrap();
        let env: ServerEnv = [
            ("BB_DATA_DIR", path("data")),
            ("BB_SERVER_PORT", "0".to_owned()),
            ("BB_SERVER_BIND_HOST", "127.0.0.1".to_owned()),
            ("BB_APP_DIR", path("app")),
            ("BB_LOG_LEVEL", "silent".to_owned()),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value))
        .collect();
        let config = load_config(&env).unwrap();
        let (connect, local) = local_runner_for(&config, vec![]);
        let clock = Arc::new(AtomicI64::new(START));
        let now = clock.clone();
        let mut options = CreateServerOptions::new(config, connect);
        options.now = Some(Arc::new(move || now.load(Ordering::SeqCst)));
        options.builtins = Some(vec![]);
        let server = bb_server::server::create_server(options).unwrap();
        let url = server.listen().await.unwrap().url;
        Self { server, url, clock, http: reqwest::Client::new(), local, _dirs: dirs }
    }

    pub fn now(&self) -> i64 {
        self.clock.load(Ordering::SeqCst)
    }

    pub async fn request(
        &self,
        method: &str,
        url: &str,
        body: Option<Value>,
        bearer: Option<&str>,
    ) -> (StatusCode, Value) {
        let method = reqwest::Method::from_bytes(method.as_bytes()).unwrap();
        let mut request = self.http.request(method, url);
        if let Some(body) = body {
            request = request.json(&body);
        }
        if let Some(token) = bearer {
            request = request.bearer_auth(token);
        }
        let response = request.send().await.unwrap();
        let status = response.status();
        let text = response.text().await.unwrap();
        (status, serde_json::from_str(&text).unwrap_or(Value::String(text)))
    }

    pub async fn api(&self, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        self.request(method, &format!("{}/api/v1{path}", self.url), body, None).await
    }

    pub async fn create_machine(&self) -> String {
        let body = json!({ "machineProviderId": "manual", "inputs": null });
        let (status, host) = self.api("POST", "/hosts", Some(body)).await;
        assert_eq!(status, StatusCode::CREATED, "{host}");
        host["id"].as_str().unwrap().to_owned()
    }

    pub fn host_row(&self, host_id: &str) -> Value {
        let rows = self.server.ctx.db.rows("SELECT * FROM hosts WHERE id = ?", [host_id]).unwrap();
        serde_json::to_value(rows).unwrap()[0].clone()
    }

    pub fn is_connected(&self, host_id: &str) -> bool {
        self.server.ctx.runners.is_connected(host_id)
    }

    pub async fn close(self) {
        self.server.close().await;
        self.local.shutdown().await;
    }
}

/// Relays TCP between the runner and the server; `sever` destroys every relayed socket.
pub struct Relay {
    pub url: String,
    pipes: Arc<Mutex<Vec<JoinHandle<()>>>>,
    accept: JoinHandle<()>,
}

impl Relay {
    pub async fn start(target_url: &str) -> Self {
        let target_port = url::Url::parse(target_url).unwrap().port().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let pipes: Arc<Mutex<Vec<JoinHandle<()>>>> = Arc::default();
        let tracked = pipes.clone();
        let accept = tokio::spawn(async move {
            while let Ok((mut inbound, _)) = listener.accept().await {
                let pipe = tokio::spawn(async move {
                    let target = ("127.0.0.1", target_port);
                    if let Ok(mut outbound) = TcpStream::connect(target).await {
                        let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
                    }
                });
                let mut pipes = tracked.lock();
                pipes.retain(|pipe| !pipe.is_finished());
                pipes.push(pipe);
            }
        });
        Self { url: format!("http://127.0.0.1:{port}"), pipes, accept }
    }

    pub fn sever(&self) {
        for pipe in self.pipes.lock().drain(..) {
            pipe.abort();
        }
    }
}

impl Drop for Relay {
    fn drop(&mut self) {
        self.sever();
        self.accept.abort();
    }
}

pub struct Batch {
    pub seq: u64,
    pub types: Vec<String>,
}

/// An enrolled machine whose runner dials the server through a relay.
pub struct Machine {
    pub host_id: String,
    pub data_dir: TempDir,
    pub relay: Relay,
    pub seen: Arc<Mutex<Vec<Batch>>>,
    /// `true` lets handlers finish; `false` holds every batch delivered from now on.
    pub gate: watch::Sender<bool>,
    running: Option<RunningRunner>,
    server: SharedServer,
}

type SharedServer = bb_server::context::Ctx;

impl Machine {
    pub async fn enroll(server: &TestServer) -> Self {
        let relay = Relay::start(&server.url).await;
        let data_dir = tempfile::Builder::new().prefix("bb-remote-machine-").tempdir().unwrap();
        let host_id = server.create_machine().await;
        let issued = format!("{}/api/v1/hosts/{host_id}/enrollment-command", relay.url);
        let (status, issued) = server.request("GET", &issued, None, None).await;
        assert_eq!(status, StatusCode::OK, "{issued}");
        let command = issued["command"].as_str().unwrap();
        let legacy_path = data_dir.path().join("legacy-config.json");
        let legacy = json!({ "machineCredential": "bbcm_legacy" }).to_string();
        std::fs::write(&legacy_path, &legacy).unwrap();
        let blob = command.split(' ').next_back().unwrap_or_default().to_owned();
        join_server(JoinOptions {
            blob,
            data_dir: Some(data_dir.path().to_path_buf()),
            host_name: Some("laptop".into()),
            headers: vec!["X-Extra=one=two".into()],
            legacy_machine_config_path: Some(legacy_path.clone()),
        })
        .await
        .unwrap();
        assert_eq!(std::fs::read_to_string(&legacy_path).unwrap(), legacy);
        let seen: Arc<Mutex<Vec<Batch>>> = Arc::default();
        let (gate, _) = watch::channel(true);
        let (record, held, mine) = (seen.clone(), gate.clone(), host_id.clone());
        let handler = Arc::new(move |event: RunnerEvent, event_host: String| {
            let mut open = held.subscribe();
            if event_host == mine
                && let RunnerEventBody::ThreadEvents { events, .. } = &event.body
            {
                let types = events
                    .iter()
                    .map(|event| event["type"].as_str().unwrap_or_default().to_owned())
                    .collect();
                record.lock().push(Batch { seq: event.seq.unwrap_or_default(), types });
            }
            let fut: futures::future::BoxFuture<'static, _> = Box::pin(async move {
                let _ = open.wait_for(|open| *open).await;
                Ok(())
            });
            fut
        });
        server.server.ctx.runners.on_event("thread.events", handler).forever();
        let ctx = server.server.ctx.clone();
        Self { host_id, data_dir, relay, seen, gate, running: None, server: ctx }
    }

    pub fn credentials_file(&self) -> PathBuf {
        self.data_dir.path().join("runner.json")
    }

    pub async fn run(&mut self) {
        let adapters = bb_runner::default_adapters()
            .into_iter()
            .filter(|adapter| adapter.id().as_str() == "echo")
            .collect();
        let running = run_runner(RunOptions {
            data_dir: self.data_dir.path().to_path_buf(),
            make_local: bb_runner::local_factory("/opt/bb/bin/bb".into(), adapters),
            log: Some(Arc::new(|_: &str| {})),
        })
        .await
        .unwrap();
        self.running = Some(running);
    }

    pub async fn connected(&self) {
        until(|| self.server.runners.is_connected(&self.host_id).then_some(())).await;
    }

    pub fn remote(&self) -> SharedRunner {
        self.server.runners.get(&self.host_id).unwrap()
    }

    pub fn types(&self) -> Vec<String> {
        self.seen.lock().iter().flat_map(|batch| batch.types.clone()).collect()
    }

    pub fn seqs(&self) -> Vec<u64> {
        self.seen.lock().iter().map(|batch| batch.seq).collect()
    }

    pub fn seen_len(&self) -> usize {
        self.seen.lock().len()
    }

    pub async fn stop(mut self) {
        if let Some(running) = self.running.take() {
            tokio::time::timeout(Duration::from_secs(10), running.stop()).await.unwrap();
        }
    }
}
