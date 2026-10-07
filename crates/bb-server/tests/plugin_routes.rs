use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use axum::Router;
use axum::body::Body;
use axum::extract::Request;
use axum::response::{IntoResponse, Response};
use bb_server::config::ServerConfig;
use bb_server::context::{Ctx, ServerContext};
use bb_server::db::Db;
use bb_server::http::routes::plugins::router;
use bb_server::http::trust::Principal;
use bb_server::log::{LogLevel, Logger};
use bb_server::plugins::api::*;
use bb_server::plugins::builtin::{BuiltinPlugin, BuiltinServer};
use bb_server::plugins::cli::{CliCommand, CliSpec, cli_output, define_cli};
use bb_server::plugins::deps::create_plugin_host_deps;
use bb_server::plugins::host::{PluginHost, PluginHostOptions};
use bb_server::plugins::instance::PluginApi;
use bb_server::runners::registry::RunnerRegistry;
use bb_server::ws::hub::Hub;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

const ID: &str = "plugin-alpha";

struct Echo;
#[async_trait]
impl RpcHandler for Echo {
    async fn call(&self, input: Value) -> Result<Value, RpcFailure> {
        match input.get("mode").and_then(Value::as_str) {
            Some("throw") => Err(RpcFailure::handler("boom")),
            Some("bad") => Err(RpcFailure::invalid_input("Expected object")),
            _ => Ok(json!({ "echo": input })),
        }
    }
}

struct Hello;
#[async_trait]
impl HttpHandler for Hello {
    async fn handle(&self, request: Request) -> Response {
        format!("hello {}", request.uri().path()).into_response()
    }
}

struct Alpha;
#[async_trait]
impl NativePlugin for Alpha {
    async fn start(&self, api: PluginApi) -> PluginResult<()> {
        let schema = json!({ "token": { "type": "string", "label": "Token", "secret": true },
            "name": { "type": "string", "label": "Name" } });
        api.settings_define(serde_json::from_value(schema).unwrap());
        api.rpc_register("echo", Arc::new(Echo));
        api.http_route("GET", "/local", HttpAuth::Local, Arc::new(Hello));
        api.http_route("GET", "/tok/x", HttpAuth::Token, Arc::new(Hello));
        api.http_route("POST", "/", HttpAuth::None, Arc::new(Hello));
        let slow = CliCommand::new("Slow", |_, context: CliContext| async move {
            tokio::time::sleep(Duration::from_secs(25)).await;
            cli_output(format!("done {}\n", context.cwd.unwrap_or_default()))
        });
        api.cli_register(define_cli(CliSpec::new("alpha", "Alpha").command("slow", slow)))
    }
}

struct Fixture {
    _temp: tempfile::TempDir,
    app: Router,
    ctx: Ctx,
}

async fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().to_path_buf();
    let directory = root.join("builtin/alpha");
    std::fs::create_dir_all(&directory).unwrap();
    let package = json!({ "name": "@bb/plugin-alpha", "bb": { "name": "Alpha" } });
    std::fs::write(directory.join("package.json"), package.to_string()).unwrap();
    std::fs::write(directory.join("icon.svg"), "<svg/>").unwrap();
    let data_dir = root.join("data");
    std::fs::create_dir_all(&data_dir).unwrap();
    let config = ServerConfig {
        data_dir,
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
    let db = Db::open_in_memory(None).unwrap();
    let hub = Hub::new();
    let builtins =
        vec![BuiltinPlugin { directory, server: BuiltinServer::Native(Arc::new(Alpha)) }];
    let plugins = PluginHost::new(PluginHostOptions {
        config: config.clone(),
        db: db.clone(),
        hub: hub.clone(),
        log: Logger::silent(),
        builtins: Some(builtins),
    });
    let ctx: Ctx = Arc::new(ServerContext {
        config,
        db,
        hub,
        runners: RunnerRegistry::new("host", Logger::silent()),
        plugins,
        log: Logger::silent(),
        engine: Default::default(),
        environments: Default::default(),
        terminals: Default::default(),
    });
    ctx.plugins.set_deps(create_plugin_host_deps(&ctx));
    ctx.plugins.reload(None).await.unwrap();
    let app = router().with_state(ctx.clone());
    Fixture { _temp: temp, app, ctx }
}

async fn send(
    app: &Router,
    principal: Principal,
    method: &str,
    uri: &str,
    body: &str,
) -> (u16, Response) {
    let mut request =
        Request::builder().method(method).uri(uri).body(Body::from(body.to_owned())).unwrap();
    request.extensions_mut().insert(principal);
    let response = app.clone().oneshot(request).await.unwrap();
    (response.status().as_u16(), response)
}

async fn text(response: Response) -> String {
    String::from_utf8(response.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap()
}

async fn call(
    app: &Router,
    principal: Principal,
    method: &str,
    uri: &str,
    body: &str,
) -> (u16, Value) {
    let (status, response) = send(app, principal, method, uri, body).await;
    let body = text(response).await;
    (status, serde_json::from_str(&body).unwrap_or(Value::String(body)))
}

fn runner() -> Principal {
    Principal::Runner { connect_machine_id: None }
}

#[tokio::test]
async fn rpc_outcomes() {
    let Fixture { app, _temp, .. } = fixture().await;
    let o = Principal::Owner;
    let uri = format!("/plugins/{ID}/rpc/echo");
    let (status, body) = call(&app, o.clone(), "POST", &uri, r#"{"a":1}"#).await;
    assert_eq!((status, body), (200, json!({ "ok": true, "result": { "echo": { "a": 1 } } })));
    let (status, body) = call(&app, o.clone(), "POST", &uri, "").await;
    assert_eq!((status, body), (200, json!({ "ok": true, "result": { "echo": null } })));
    let (status, body) = call(&app, o.clone(), "POST", &uri, "{").await;
    let invalid = json!({ "code": "invalid_json", "message": "The request body must be JSON" });
    assert_eq!((status, body), (400, json!({ "ok": false, "error": invalid })));
    let (status, body) = call(&app, o.clone(), "POST", &uri, r#"{"mode":"bad"}"#).await;
    assert_eq!((status, &body["error"]["code"]), (400, &json!("invalid_input")));
    let (status, body) = call(&app, o.clone(), "POST", &uri, r#"{"mode":"throw"}"#).await;
    let failed = json!({ "code": "handler_error", "message": "boom" });
    assert_eq!((status, body), (500, json!({ "ok": false, "error": failed })));
    let (status, body) =
        call(&app, o.clone(), "POST", &format!("/plugins/{ID}/rpc/nope"), "{}").await;
    let message = format!("Plugin \"{ID}\" has no rpc method \"nope\"");
    let unknown = json!({ "code": "unknown_method", "message": message });
    assert_eq!((status, body), (404, json!({ "ok": false, "error": unknown })));
    let (status, body) = call(&app, o, "POST", "/plugins/missing/rpc/echo", "{}").await;
    assert_eq!((status, &body["error"]["code"]), (404, &json!("plugin_unavailable")));
}

#[tokio::test]
async fn plugin_http_auth_modes() {
    let Fixture { app, ctx, _temp } = fixture().await;
    let base = format!("/plugins/{ID}/http");
    let (status, response) =
        send(&app, Principal::Owner, "GET", &format!("{base}/local"), "").await;
    assert_eq!(
        (status, text(response).await.as_str()),
        (200, "hello /plugins/plugin-alpha/http/local")
    );
    let (status, body) = call(&app, runner(), "GET", &format!("{base}/local"), "").await;
    assert_eq!((status, &body["code"]), (403, &json!("forbidden")));
    let (status, body) = call(&app, Principal::Owner, "GET", &format!("{base}/tok/x"), "").await;
    assert_eq!((status, &body["code"]), (401, &json!("invalid_plugin_token")));
    let token = ctx.plugins.token(ID, false).unwrap();
    let (status, _) = send(&app, runner(), "GET", &format!("{base}/tok/x?token={token}"), "").await;
    assert_eq!(status, 200);
    let mut request = Request::get(format!("{base}/tok/x")).body(Body::empty()).unwrap();
    request.headers_mut().insert("x-bb-plugin-token", token.parse().unwrap());
    request.extensions_mut().insert(runner());
    assert_eq!(app.clone().oneshot(request).await.unwrap().status(), 200);
    let (status, _) = send(&app, runner(), "GET", &format!("{base}/tok/x?token=wrong"), "").await;
    assert_eq!(status, 401);
    let (status, _) = send(&app, runner(), "POST", &base, "").await;
    assert_eq!(status, 200);
    let (status, body) = call(&app, runner(), "GET", &format!("{base}/zzz"), "").await;
    let message = format!("Plugin \"{ID}\" has no GET route for \"/zzz\"");
    assert_eq!((status, &body["message"]), (404, &json!(message)));
}

#[tokio::test]
async fn management_is_owner_only() {
    let Fixture { app, _temp, .. } = fixture().await;
    for (method, uri) in [
        ("POST", "/plugins/reload".to_owned()),
        ("POST", format!("/plugins/{ID}/enable")),
        ("POST", format!("/plugins/{ID}/disable")),
        ("POST", format!("/plugins/{ID}/token")),
        ("PUT", format!("/plugins/{ID}/settings")),
    ] {
        let (status, body) = call(&app, runner(), method, &uri, "{}").await;
        let refused =
            json!({ "code": "forbidden", "message": "Only the owner can manage plugins" });
        assert_eq!((status, &body), (403, &refused), "{uri}");
    }
    let (status, body) =
        call(&app, Principal::Owner, "POST", &format!("/plugins/{ID}/token"), "").await;
    assert_eq!((status, body["ok"].clone()), (200, json!(true)));
    assert!(body["token"].as_str().is_some_and(|t| !t.is_empty()));
    let (status, body) =
        call(&app, Principal::Owner, "POST", &format!("/plugins/{ID}/disable"), "").await;
    assert_eq!((status, body["ok"].clone()), (200, json!(true)));
    let (status, body) = call(&app, Principal::Owner, "GET", "/plugins", "").await;
    assert_eq!((status, body["plugins"][0]["id"].clone()), (200, json!(ID)));
    let (status, body) = call(&app, Principal::Owner, "GET", "/plugins/contributions", "").await;
    assert!(status == 200 && body.is_object());
}

#[tokio::test]
async fn settings_round_trip_hides_secrets() {
    let Fixture { app, _temp, .. } = fixture().await;
    let uri = format!("/plugins/{ID}/settings");
    let update = json!({ "values": { "token": "s3cret", "name": "N" } }).to_string();
    let (status, written) = call(&app, Principal::Owner, "PUT", &uri, &update).await;
    assert_eq!(status, 200);
    let (status, read) = call(&app, runner(), "GET", &uri, "").await;
    assert_eq!((status, &read), (200, &written));
    assert_eq!(read["values"]["name"], json!("N"));
    assert_ne!(read["values"]["token"], json!("s3cret"));
    assert_eq!(read["schema"]["token"]["secret"], json!(true));
    let (status, body) = call(&app, Principal::Owner, "PUT", &uri, "{nope").await;
    assert_eq!((status, &body["message"]), (400, &json!("The request body must be JSON")));
}

#[tokio::test(start_paused = true)]
async fn cli_streams_keepalives_then_the_result() {
    let Fixture { app, _temp, .. } = fixture().await;
    let body = json!({ "argv": ["slow"], "cwd": "/w" }).to_string();
    let (status, response) =
        send(&app, runner(), "POST", &format!("/plugins/{ID}/cli"), &body).await;
    assert_eq!(status, 200);
    assert_eq!(response.headers()["content-type"], "application/json");
    let mut body = response.into_body();
    let mut chunks = Vec::new();
    while let Some(frame) = body.frame().await {
        let data = frame.unwrap().into_data().unwrap();
        chunks.push(String::from_utf8(data.to_vec()).unwrap());
    }
    let result = json!({ "exitCode": 0, "stdout": "done /w\n", "stderr": "" }).to_string();
    assert_eq!(chunks, vec!["\n".to_owned(), "\n".to_owned(), result]);
    let body = json!({ "argv": [] }).to_string();
    let (_, value) = call(&app, runner(), "POST", "/plugins/missing/cli", &body).await;
    assert_eq!(value["exitCode"], json!(1));
}

#[tokio::test]
async fn mentions_and_assets() {
    let Fixture { app, _temp, .. } = fixture().await;
    let (status, body) =
        call(&app, runner(), "GET", "/plugins/mentions/search?q=%20x&trigger=%23", "").await;
    assert_eq!((status, body), (200, json!({ "ok": true, "groups": [] })));
    let (status, body) =
        call(&app, runner(), "GET", "/plugins/mentions/search?trigger=z", "").await;
    assert_eq!((status, &body["message"]), (400, &json!("Invalid mention search query")));
    let (status, response) =
        send(&app, runner(), "GET", &format!("/plugins/{ID}/assets/icon.svg"), "").await;
    assert_eq!(
        (status, response.headers()["content-type"].to_str().unwrap()),
        (200, "image/svg+xml")
    );
    let (status, _) =
        send(&app, runner(), "GET", &format!("/plugins/{ID}/assets/package.json"), "").await;
    assert_eq!(status, 404);
    let (status, _) =
        send(&app, runner(), "GET", &format!("/plugins/{ID}/assets/../x.svg"), "").await;
    assert_eq!(status, 404);
    let (status, _) = send(&app, runner(), "GET", &format!("/plugins/{ID}/app.js"), "").await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn deps_sections_and_reads() {
    let Fixture { ctx, _temp, .. } = fixture().await;
    let outward = create_plugin_host_deps(&ctx)(ID);
    let section = outward.sections_create("  Work ").await.unwrap();
    assert_eq!(section["name"], json!("Work"));
    let sections = outward.sections_list().await.unwrap();
    assert_eq!(sections[0]["id"], section["id"]);
    assert!(outward.sections_create("Work").await.is_err());
    assert_eq!(outward.threads_output("thr_none").await.unwrap(), None);
    assert!(outward.threads_events("thr_none", None).await.unwrap().is_empty());
    assert!(outward.projects_list().await.unwrap().is_array());
    assert!(outward.hosts_list().await.unwrap().is_array());
    assert!(
        outward
            .files_read(FileReadArgs {
                thread_id: "thr_none".into(),
                path: "a".into(),
                encoding: None
            })
            .await
            .is_err()
    );
}
