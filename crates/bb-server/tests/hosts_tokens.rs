//! Port of "expires join tokens, reissues them and revokes on removal" from
//! apps/server/test/hosts.test.ts, against a real server on port 0.

mod remote_runner_support;

use std::sync::Arc;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use base64::Engine;
use bb_core::{RunnerApi, RunnerResult, SharedRunner};
use bb_server::db::settings::{get_app_settings, set_app_settings};
use bb_server::runners::enrollment::JOIN_TOKEN_TTL_MS;
use parking_lot::Mutex;
use remote_runner_support::{TestServer, until};
use reqwest::StatusCode;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;

struct FakeRunner;

#[async_trait]
impl RunnerApi for FakeRunner {
    async fn call(&self, _method: &str, _params: Value) -> RunnerResult<Value> {
        Ok(Value::Null)
    }
}

fn fake_runner() -> bb_server::runners::registry::RunnerFactory {
    Box::new(|_sink| Arc::new(FakeRunner) as SharedRunner)
}

fn decode_join_command(command: &Value) -> Value {
    let parts: Vec<&str> = command.as_str().unwrap_or_default().split(' ').collect();
    assert_eq!(parts[..3], ["bb", "runner", "join"], "{command}");
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(parts[3].trim_end_matches('='))
        .unwrap();
    serde_json::from_slice(&decoded).unwrap()
}

async fn join(server: &TestServer, token: &str) -> (StatusCode, String) {
    let url = format!("{}/internal/runner/join", server.url);
    let (status, body) =
        server.request("POST", &url, Some(json!({ "hostName": "mini" })), Some(token)).await;
    (status, body["runnerToken"].as_str().unwrap_or_default().to_owned())
}

async fn dial(server: &TestServer, token: &str) -> String {
    let target = format!("{}/internal/runner/ws", server.url.replacen("http", "ws", 1));
    let mut request = target.into_client_request().unwrap();
    let bearer = HeaderValue::from_str(&format!("Bearer {token}")).unwrap();
    request.headers_mut().insert("authorization", bearer);
    match tokio_tungstenite::connect_async(request).await {
        Ok((mut socket, _)) => {
            let _ = socket.close(None).await;
            "accepted".to_owned()
        }
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            format!("refused {}", response.status().as_u16())
        }
        Err(error) => format!("failed {error}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn expires_join_tokens_reissues_them_and_revokes_on_removal() {
    let server = TestServer::start().await;
    let ctx = server.server.ctx.clone();
    let changes: Arc<Mutex<Vec<String>>> = Arc::default();
    let record = changes.clone();
    let _watch = ctx.hub.on_changed(move |message| {
        record.lock().push(serde_json::to_string(message).unwrap());
    });
    let id = server.create_machine().await;
    let enrollment = format!("/hosts/{id}/enrollment-command");
    let (status, first) = server.api("GET", &enrollment, None).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["expiresAt"], json!(server.now() + JOIN_TOKEN_TTL_MS));
    server.clock.fetch_add(JOIN_TOKEN_TTL_MS, Ordering::SeqCst);
    assert_eq!(server.api("GET", &enrollment, None).await.1, Value::Null);
    let expired = decode_join_command(&first["command"])["joinToken"].as_str().unwrap().to_owned();
    assert_eq!(join(&server, &expired).await.0, StatusCode::UNAUTHORIZED);

    let reconnect = format!("/hosts/{id}/reconnect-commands");
    let (status, refused) = server.api("POST", &reconnect, None).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    ctx.runners.connect(&id, fake_runner());
    let (status, refused) = server.api("POST", &reconnect, None).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    ctx.runners.disconnect(&id, None);

    let public_url = "https://bee.example.test";
    let mut settings = get_app_settings(&ctx.db).unwrap();
    settings.machine_server_url = Some(format!("{public_url}/"));
    set_app_settings(&ctx.db, &settings).unwrap();
    let (status, reissued) = server.api("POST", &reconnect, None).await;
    assert_eq!(status, StatusCode::CREATED, "{reissued}");
    assert_eq!(reissued["hostId"], json!(id));
    assert_eq!(reissued["expiresAt"], json!(server.now() + JOIN_TOKEN_TTL_MS));
    let blob = decode_join_command(&reissued["command"]);
    assert_eq!(blob["serverUrl"], public_url);
    let (status, token) = join(&server, blob["joinToken"].as_str().unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    assert!(token.starts_with("bbr_"), "{token}");

    let (status, removed) = server.api("DELETE", &format!("/hosts/{id}"), None).await;
    assert_eq!(status, StatusCode::OK, "{removed}");
    until(|| {
        let changes = changes.lock();
        changes
            .iter()
            .any(|change| change.contains(&id) && change.contains("host-disconnected"))
            .then_some(())
    })
    .await;
    assert_eq!(server.api("GET", &format!("/hosts/{id}"), None).await.0, StatusCode::NOT_FOUND);
    assert_eq!(dial(&server, &token).await, "refused 401");
    server.close().await;
}
