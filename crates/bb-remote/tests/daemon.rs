use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bb_core::{RunnerApi, RunnerResult};
use bb_remote::{LocalParts, Outbox, RunOptions, run_runner};
use futures::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::protocol::CloseFrame;

struct Fake;

#[async_trait]
impl RunnerApi for Fake {
    async fn call(&self, _method: &str, _params: Value) -> RunnerResult<Value> {
        Ok(json!({"instanceId": "rin_daemon", "version": "0.0.1"}))
    }
}

#[tokio::test]
#[allow(clippy::result_large_err)]
async fn redials_after_a_drop_and_stops_when_replaced() {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::<(String, String, Value)>::new()));
    let record = seen.clone();
    tokio::spawn(async move {
        for code in [1000u16, 4001] {
            let (stream, _) = listener.accept().await.unwrap();
            let auth = Arc::new(Mutex::new((String::new(), String::new())));
            let into = auth.clone();
            let callback = move |request: &Request, response: Response| {
                let header = |name: &str| {
                    request.headers().get(name).and_then(|v| v.to_str().ok()).unwrap_or("")
                };
                *into.lock() = (header("authorization").into(), header("x-extra").into());
                assert_eq!(request.uri().path(), "/internal/runner/ws");
                Ok(response)
            };
            let mut socket = tokio_tungstenite::accept_hdr_async(stream, callback).await.unwrap();
            let Some(Ok(Message::Text(hello))) = socket.next().await else { panic!("no hello") };
            let (authorization, extra) = auth.lock().clone();
            record.lock().push((authorization, extra, serde_json::from_str(&hello).unwrap()));
            let frame = CloseFrame { code: code.into(), reason: "".into() };
            let _ = socket.send(Message::Close(Some(frame))).await;
            while socket.next().await.is_some() {}
        }
    });

    let data_dir = tempfile::tempdir().unwrap();
    let credentials = json!({
        "hostId": "host_1", "runnerToken": "bbr_1",
        "serverUrl": format!("http://127.0.0.1:{port}"), "headers": {"x-extra": "yes"}
    });
    std::fs::write(data_dir.path().join("runner.json"), credentials.to_string()).unwrap();
    let logs = Arc::new(Mutex::new(Vec::<String>::new()));
    let into = logs.clone();
    let shut = Arc::new(Mutex::new(false));
    let shut_into = shut.clone();
    let running = run_runner(RunOptions {
        data_dir: data_dir.path().to_path_buf(),
        log: Some(Arc::new(move |line: &str| into.lock().push(line.to_owned()))),
        make_local: Box::new(move |setup| LocalParts {
            runner: Arc::new(Fake),
            outbox: Outbox::new(setup.sink),
            shutdown: Box::new(move || {
                Box::pin(async move {
                    *shut_into.lock() = true;
                })
            }),
        }),
    })
    .await
    .unwrap();
    assert!(running.cli_proxy_url.starts_with("http://127.0.0.1:"));
    tokio::time::timeout(Duration::from_secs(10), running.stopped()).await.unwrap();
    assert!(*shut.lock());
    let seen = seen.lock().clone();
    assert_eq!(seen.len(), 2);
    for (authorization, extra, hello) in seen {
        assert_eq!((authorization.as_str(), extra.as_str()), ("Bearer bbr_1", "yes"));
        assert_eq!(hello["instanceId"], "rin_daemon");
    }
    assert_eq!(
        *logs.lock(),
        [
            "bb runner: disconnected (1000); retrying in 1000 ms",
            "bb runner: this machine was replaced or removed; stopping"
        ]
    );
}

#[tokio::test]
async fn join_stores_credentials_with_merged_headers() {
    use base64::Engine;
    use bytes::Bytes;
    use http_body_util::{BodyExt, Full};
    use hyper_util::rt::TokioIo;
    use std::os::unix::fs::PermissionsExt;

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::<(String, String, String, Value)>::new()));
    let record = seen.clone();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let service = hyper::service::service_fn(move |request: hyper::Request<_>| {
            let record = record.clone();
            async move {
                let header = |name: &str| {
                    let value = request.headers().get(name).and_then(|v| v.to_str().ok());
                    value.unwrap_or("").to_owned()
                };
                let (path, auth, extra) =
                    (request.uri().path().to_owned(), header("authorization"), header("x-extra"));
                let body: hyper::body::Incoming = request.into_body();
                let body = body.collect().await.unwrap().to_bytes();
                record.lock().push((path, auth, extra, serde_json::from_slice(&body).unwrap()));
                let reply = json!({"hostId": "host_9", "runnerToken": "bbr_9"}).to_string();
                Ok::<_, std::convert::Infallible>(hyper::Response::new(Full::new(Bytes::from(
                    reply,
                ))))
            }
        });
        let connection = hyper::server::conn::http1::Builder::new();
        let _ = connection.serve_connection(TokioIo::new(stream), service).await;
    });
    let blob = json!({
        "serverUrl": format!("http://127.0.0.1:{port}/"), "hostId": "host_9",
        "joinToken": "join_1", "headers": {"x-extra": "blob", "x-keep": "1"}
    });
    let blob = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(blob.to_string());
    let dir = tempfile::tempdir().unwrap();
    let (credentials, data_dir) = bb_remote::join_server(bb_remote::JoinOptions {
        blob,
        data_dir: Some(dir.path().join("runner")),
        host_name: Some("box".into()),
        headers: vec!["X-Extra=flag".into()],
        legacy_machine_config_path: None,
    })
    .await
    .unwrap();
    assert_eq!(data_dir, dir.path().join("runner"));
    let seen = seen.lock().clone();
    assert_eq!(
        seen,
        [(
            "/internal/runner/join".to_owned(),
            "Bearer join_1".to_owned(),
            "flag".to_owned(),
            json!({"hostName": "box"})
        )]
    );
    let file = data_dir.join("runner.json");
    let stored = std::fs::read_to_string(&file).unwrap();
    let expected = json!({
        "hostId": "host_9", "runnerToken": "bbr_9", "serverUrl": format!("http://127.0.0.1:{port}"),
        "headers": {"x-extra": "flag", "x-keep": "1"}
    });
    assert_eq!(stored, format!("{}\n", serde_json::to_string_pretty(&expected).unwrap()));
    assert_eq!(credentials.runner_token, "bbr_9");
    assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
}
