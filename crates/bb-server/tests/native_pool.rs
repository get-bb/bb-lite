//! The native Account Pooler loaded through a `PluginHost`, with fake upstream and OAuth clients.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use axum::body::Body;
use bb_pool::hub::UpstreamClient;
use bb_pool::oauth::HttpClient;
use bb_server::config::ServerConfig;
use bb_server::db::Db;
use bb_server::error::ApiResult;
use bb_server::log::{LogLevel, Logger};
use bb_server::plugins::api::*;
use bb_server::plugins::builtin::{BuiltinServer, builtin_plugins};
use bb_server::plugins::host::{PluginHost, PluginHostOptions};
use bb_server::plugins::instance::PluginInstance;
use bb_server::plugins::native::pool::AccountPoolPlugin;
use bb_server::ws::hub::Hub;
use bytes::Bytes;
use parking_lot::Mutex;
use serde_json::{Value, json};

const POOL: &str = "account-pool";

struct Outward;

#[async_trait]
impl PluginOutward for Outward {
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
        Ok(json!([{ "id": "host-a", "name": "Laptop" }]))
    }
    async fn sections_list(&self) -> ApiResult<Value> {
        Ok(json!([]))
    }
    async fn sections_create(&self, _: &str) -> ApiResult<Value> {
        Ok(Value::Null)
    }
    async fn files_read(&self, _: FileReadArgs) -> ApiResult<Option<FileRead>> {
        Ok(None)
    }
    async fn files_write(&self, _: FileWriteArgs) -> ApiResult<FileWriteOutcome> {
        unimplemented!()
    }
    async fn request_input(&self, _: InputRequest) -> InputResult {
        InputResult::Cancelled { reason: "test".into() }
    }
}

/// Records every proxied request and answers 200 with a fixed body.
#[derive(Default)]
struct FakeUpstream {
    seen: Mutex<Vec<http::Request<Bytes>>>,
}

#[async_trait]
impl UpstreamClient for FakeUpstream {
    async fn send(&self, request: http::Request<Bytes>) -> Result<http::Response<Body>, String> {
        self.seen.lock().push(request);
        Ok(http::Response::new(Body::from(r#"{"id":"msg_1"}"#)))
    }
}

/// Answers every OAuth or usage request with 404; records the URLs.
#[derive(Default)]
struct FakeHttp {
    seen: Mutex<Vec<String>>,
}

#[async_trait]
impl HttpClient for FakeHttp {
    async fn send(&self, request: http::Request<Bytes>) -> Result<http::Response<Bytes>, String> {
        self.seen.lock().push(request.uri().to_string());
        let mut response = http::Response::new(Bytes::new());
        *response.status_mut() = http::StatusCode::NOT_FOUND;
        Ok(response)
    }
}

struct Fixture {
    host: PluginHost,
    upstream: Arc<FakeUpstream>,
    _temp: tempfile::TempDir,
}

fn fixture(home: Option<&Path>) -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let upstream = Arc::new(FakeUpstream::default());
    let mut plugin =
        AccountPoolPlugin::with_clients(upstream.clone(), Arc::new(FakeHttp::default()));
    plugin = plugin.with_home(home.map_or_else(|| root.join("home"), Path::to_path_buf));
    let builtins = builtin_plugins()
        .into_iter()
        .filter(|p| p.directory.ends_with(POOL))
        .map(|mut p| {
            assert!(matches!(p.server, BuiltinServer::Native(_)));
            p.server = BuiltinServer::Native(Arc::new(plugin.clone()));
            p
        })
        .collect();
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
    let host = PluginHost::new(PluginHostOptions {
        config,
        db: Db::open_in_memory(None).unwrap(),
        hub: Hub::new(),
        log: Logger::silent(),
        builtins: Some(builtins),
    });
    host.set_deps(Arc::new(|_: &str| Arc::new(Outward) as Arc<dyn PluginOutward>));
    Fixture { host, upstream, _temp: temp }
}

impl Fixture {
    async fn start(home: Option<&Path>) -> Self {
        let fixture = fixture(home);
        fixture.host.reload(None).await.unwrap();
        fixture
    }

    fn instance(&self) -> Arc<PluginInstance> {
        self.host.running(POOL).unwrap()
    }

    async fn rpc(&self, method: &str, input: Value) -> Result<Value, RpcFailure> {
        self.instance().rpc(method).expect(method).call(input).await
    }

    async fn cli(&self, argv: &[&str]) -> CliResult {
        let argv = argv.iter().map(|arg| (*arg).to_owned()).collect();
        self.instance().cli().unwrap().run(argv, CliContext::default()).await
    }

    async fn stdout(&self, argv: &[&str]) -> String {
        let result = self.cli(argv).await;
        assert_eq!(result.exit_code, 0, "{argv:?}: {}", result.stderr);
        result.stdout
    }

    async fn env(&self, provider_id: &str, host_id: Option<&str>) -> Vec<ProviderEnvEntry> {
        let context = ThreadContext {
            thread_id: "t1".into(),
            project_id: "p1".into(),
            host_id: host_id.map(str::to_owned),
            provider_id: provider_id.into(),
            provider_capabilities: None,
        };
        self.host.contributed_env(provider_id, &context).await
    }

    fn listed(&self) -> Value {
        self.host.list().into_iter().find(|p| p["id"] == POOL).unwrap()
    }
}

fn names(entries: &[ProviderEnvEntry]) -> Vec<&str> {
    entries.iter().map(|entry| entry.name.as_str()).collect()
}

#[tokio::test(flavor = "current_thread")]
async fn empty_pool_needs_configuration_and_reports_status() {
    let pool = Fixture::start(None).await;
    let listed = pool.listed();
    assert_eq!(listed["status"], "needs-configuration");
    assert_eq!(
        listed["statusMessage"],
        "Add and enable a Claude or Codex account with `bb pool account add`."
    );
    let status = pool.rpc("status", json!({})).await.unwrap();
    assert_eq!(status["route"], "/api/v1/plugins/account-pool/http");
    assert_eq!(status["hosts"], json!([]));
    assert_eq!(status["accounts"], json!([]));
    assert_eq!(status["routing"], json!({ "claude": true, "codex": true }));
    assert_eq!(status["config"]["switchThreshold"], json!(0.98));
    let text = pool.stdout(&["status"]).await;
    assert_eq!(
        text,
        "Route: /api/v1/plugins/account-pool/http\nRouting: claude, codex\nSwitch threshold: 0.98\nMachine tokens: none minted\n\nNo accounts configured.\n"
    );
    assert_eq!(pool.stdout(&["account", "list"]).await, "No accounts configured.\n");
    assert_eq!(pool.stdout(&["account", "list", "--json"]).await, "{\n  \"accounts\": []\n}\n");
    assert!(pool.env("claude-code", Some("host-a")).await.is_empty());
    assert!(pool.env("codex", Some("host-a")).await.is_empty());
    pool.host.stop().await;
}

#[tokio::test(flavor = "current_thread")]
async fn rpc_validates_input_and_adds_api_keys() {
    let pool = Fixture::start(None).await;
    let bad = pool.rpc("account.update", json!({ "id": "nope" })).await.unwrap_err();
    assert_eq!(bad.code, RpcErrorCode::InvalidInput);
    assert_eq!(bad.message, "id: Invalid UUID");
    let bad = pool.rpc("config.set", json!({ "switchThreshold": 1.5 })).await.unwrap_err();
    assert_eq!(bad.code, RpcErrorCode::InvalidInput);
    let bad = pool.rpc("routing.set", json!({ "provider": "gpt", "enabled": true })).await;
    assert_eq!(bad.unwrap_err().code, RpcErrorCode::InvalidInput);
    let codex_key = json!({ "provider": "codex", "apiKey": "k", "label": null, "priority": 1 });
    let refused = pool.rpc("account.add", codex_key).await.unwrap_err();
    assert_eq!(refused.code, RpcErrorCode::HandlerError);
    assert_eq!(refused.message, "API keys are only supported for the claude provider.");

    let input = json!({ "provider": "claude", "apiKey": "sk-ant-1", "label": null, "priority": 5 });
    let account = pool.rpc("account.add", input).await.unwrap();
    assert_eq!(account["label"], "Claude API key");
    assert_eq!(account["kind"], "api-key");
    assert_eq!(account["priority"], 5);
    let id = account["id"].as_str().unwrap().to_owned();
    let missing = "00000000-0000-4000-8000-000000000000";
    let update = json!({ "id": missing, "enabled": false });
    let error = pool.rpc("account.update", update).await.unwrap_err();
    assert_eq!(error.message, format!("Account {missing} does not exist."));
    let error = pool.rpc("account.refresh", json!({ "id": missing })).await.unwrap_err();
    assert_eq!(error.message, format!("Account {missing} does not exist."));
    let update = json!({ "id": id, "priority": 9 });
    assert_eq!(pool.rpc("account.update", update).await.unwrap(), Value::Null);
    let routing = json!({ "provider": "codex", "enabled": false });
    assert_eq!(pool.rpc("routing.set", routing).await.unwrap(), Value::Null);
    let config = json!({ "switchThreshold": 0.5 });
    assert_eq!(pool.rpc("config.set", config).await.unwrap(), Value::Null);
    let status = pool.rpc("status", json!({})).await.unwrap();
    assert_eq!(status["routing"], json!({ "claude": true, "codex": false }));
    assert_eq!(status["config"]["switchThreshold"], json!(0.5));
    assert_eq!(status["accounts"][0]["priority"], 9);
    assert_eq!(status["accounts"][0]["status"], "ready");
    pool.host.stop().await;
}

#[tokio::test(flavor = "current_thread")]
async fn cli_manages_accounts_routing_and_config() {
    let pool = Fixture::start(None).await;
    let added =
        pool.cli(&["account", "add", "--provider", "claude", "--api-key", "sk-1", "--json"]).await;
    let added: Value = serde_json::from_str(&added.stdout).unwrap();
    assert_eq!(added["ok"], true);
    let id = added["account"]["id"].as_str().unwrap().to_owned();
    let text = pool
        .stdout(&["account", "add", "--provider", "claude", "--api-key", "sk-2", "--label", "Two"])
        .await;
    let second: Value =
        serde_json::from_str(&pool.stdout(&["account", "list", "--json"]).await).unwrap();
    let two = second["accounts"][1]["id"].as_str().unwrap().to_owned();
    assert_eq!(text, format!("Added Two ({two}).\n"));
    assert_eq!(
        pool.stdout(&["account", "list"]).await,
        format!("{id}\tClaude API key\tclaude\t100\t-\tready\n{two}\tTwo\tclaude\t100\t-\tready\n")
    );
    assert_eq!(pool.stdout(&["account", "priority", &two, "3"]).await, "Set Two priority to 3.\n");
    assert_eq!(pool.stdout(&["account", "disable", &id]).await, format!("Disabled {id}.\n"));
    let listed = pool.stdout(&["account", "list"]).await;
    assert!(
        listed.contains(&format!("{id}\tClaude API key\tclaude\t100\t-\tdisabled")),
        "{listed}"
    );
    let enabled: Value =
        serde_json::from_str(&pool.stdout(&["account", "enable", &id, "--json"]).await).unwrap();
    assert_eq!(enabled["id"], json!(id));
    assert_eq!(enabled["account"]["enabled"], true);
    let removed: Value =
        serde_json::from_str(&pool.stdout(&["account", "remove", &two, "--json"]).await).unwrap();
    assert_eq!(removed, json!({ "ok": true, "id": two, "account": null }));
    let gone = pool.cli(&["account", "remove", &two]).await;
    assert_ne!(gone.exit_code, 0);
    assert!(gone.stderr.contains(&format!("Account {two} does not exist.")), "{}", gone.stderr);

    assert_eq!(pool.stdout(&["routing", "codex", "--off"]).await, "Disabled codex routing.\n");
    assert_eq!(
        pool.stdout(&["routing", "claude", "--json"]).await,
        "{\n  \"ok\": true,\n  \"provider\": \"claude\",\n  \"enabled\": true\n}\n"
    );
    let shown = pool.stdout(&["config", "set", "switchThreshold", "1"]).await;
    assert!(shown.ends_with("switchThreshold: 1\n"), "{shown}");
    let shown: Value = serde_json::from_str(&pool.stdout(&["config", "--json"]).await).unwrap();
    assert_eq!(shown["ok"], true);
    assert_eq!(serde_json::to_string(&shown["config"]["switchThreshold"]).unwrap(), "1");
    let status = pool.stdout(&["status"]).await;
    assert!(
        status.starts_with(
            "Route: /api/v1/plugins/account-pool/http\nRouting: claude\nSwitch threshold: 1\n"
        ),
        "{status}"
    );
    pool.host.stop().await;
}

#[tokio::test(flavor = "current_thread")]
async fn cli_help_and_errors_match_the_typescript() {
    // Generated from plugins/account-pool/src/cli.ts: `registerPoolCli` with a fake `bb`
    // and pool, then `cli.run(argv)` for each case (see the `argv` fields).
    let reference: Value =
        serde_json::from_str(include_str!("native_pool_support/cli_reference.json")).unwrap();
    let pool = Fixture::start(None).await;
    let cli = pool.instance().cli().unwrap();
    assert_eq!(cli.name(), reference["name"]);
    assert_eq!(cli.summary(), reference["summary"]);
    assert_eq!(serde_json::to_value(cli.commands()).unwrap(), reference["commands"]);
    for case in reference["out"].as_array().unwrap() {
        let argv: Vec<&str> =
            case["argv"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()).collect();
        let actual = pool.cli(&argv).await;
        let expected = &case["result"];
        assert_eq!(actual.exit_code, expected["exitCode"], "{argv:?}");
        assert_eq!(actual.stdout, expected["stdout"].as_str().unwrap_or_default(), "{argv:?}");
        assert_eq!(actual.stderr, expected["stderr"].as_str().unwrap_or_default(), "{argv:?}");
    }
    pool.host.stop().await;
}

#[tokio::test(flavor = "current_thread")]
async fn env_and_proxy_serve_once_an_account_exists() {
    let pool = Fixture::start(None).await;
    assert!(pool.env("claude-code", Some("host-a")).await.is_empty());
    let input =
        json!({ "provider": "claude", "apiKey": "sk-ant-9", "label": "Key", "priority": 1 });
    pool.rpc("account.add", input).await.unwrap();
    assert!(pool.env("claude-code", None).await.is_empty());
    assert!(pool.env("codex", Some("host-a")).await.is_empty(), "no codex account");
    let env = pool.env("claude-code", Some("host-a")).await;
    assert_eq!(
        names(&env),
        [
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_CUSTOM_HEADERS",
            "ENABLE_TOOL_SEARCH",
            "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL"
        ]
    );
    let base = EnvValue::ServerPath { server_path: "/api/v1/plugins/account-pool/http".into() };
    assert_eq!(env[0].value, base);
    let EnvValue::Literal(token) = env[1].value.clone() else { panic!("token") };
    assert_eq!(env[2].value, EnvValue::Literal(format!("x-bb-account-pool-token: {token}")));
    assert_eq!(env[3].value, EnvValue::Literal("true".into()));
    assert_eq!(env[4].value, EnvValue::Literal("1".into()));
    assert_eq!(pool.env("claude-code", Some("host-a")).await, env, "stable per host");
    let status = pool.rpc("status", json!({})).await.unwrap();
    assert_eq!(status["hosts"], json!([{ "hostId": "host-a", "hostName": "Laptop" }]));
    pool.rpc("routing.set", json!({ "provider": "claude", "enabled": false })).await.unwrap();
    assert!(pool.env("claude-code", Some("host-a")).await.is_empty(), "routing off");
    pool.rpc("routing.set", json!({ "provider": "claude", "enabled": true })).await.unwrap();

    let instance = pool.instance();
    for key in [
        "POST /v1/messages",
        "POST /v1/messages/count_tokens",
        "POST /v1/responses",
        "POST /v1/images/generations",
        "POST /v1/images/edits",
        "POST /v1/alpha/search",
        "GET /v1/models",
        "HEAD /api/hello",
    ] {
        assert_eq!(instance.route(key).expect(key).auth, HttpAuth::None, "{key}");
    }
    let hello = instance.route("HEAD /api/hello").unwrap().handler;
    let response = hello.handle(http::Request::new(Body::empty())).await;
    assert_eq!(response.status(), 200);

    let route = instance.route("POST /v1/messages").unwrap().handler;
    let request = http::Request::post("/v1/messages")
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(r#"{"model":"claude-sonnet-4-5","messages":[]}"#))
        .unwrap();
    let response = route.handle(request).await;
    assert_eq!(response.status(), 200);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(&body[..], br#"{"id":"msg_1"}"#);
    {
        let seen = pool.upstream.seen.lock();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].headers()["x-api-key"], "sk-ant-9");
        assert!(seen[0].uri().to_string().starts_with("https://api.anthropic.com/v1/messages"));
    }
    let unauthorized =
        route.handle(http::Request::post("/v1/messages").body(Body::empty()).unwrap()).await;
    assert_eq!(unauthorized.status(), 401);
    assert_eq!(pool.upstream.seen.lock().len(), 1);
    pool.host.stop().await;
}

#[tokio::test(flavor = "current_thread")]
async fn import_reads_the_injected_home_and_reload_keeps_state() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(home.path().join(".claude")).unwrap();
    let credentials = json!({ "claudeAiOauth": {
        "accessToken": "cat", "refreshToken": "crt", "expiresAt": 4_102_444_800_000_i64,
        "subscriptionType": "max", "rateLimitTier": "tier",
    }});
    std::fs::write(home.path().join(".claude/.credentials.json"), credentials.to_string()).unwrap();
    let owner = json!({ "oauthAccount": {
        "emailAddress": "owner@example.com", "accountUuid": "4f9d1c2a-6b3e-4c5d-8e7f-0a1b2c3d4e5f",
    }});
    std::fs::write(home.path().join(".claude.json"), owner.to_string()).unwrap();
    let pool = Fixture::start(Some(home.path())).await;
    let text = pool.stdout(&["account", "add", "--provider", "claude", "--import"]).await;
    assert!(text.starts_with("Added owner@example.com ("), "{text}");
    let missing = pool.cli(&["account", "add", "--provider", "codex", "--import"]).await;
    assert_ne!(missing.exit_code, 0);
    let status = pool.rpc("status", json!({})).await.unwrap();
    assert_eq!(status["accounts"][0]["kind"], "oauth");
    assert_eq!(status["accounts"][0]["subscriptionType"], "max");
    // A restart finds the account and no longer asks for configuration.
    pool.host.reload(Some(POOL)).await.unwrap();
    assert_eq!(pool.listed()["status"], "running");
    pool.host.stop().await;
}
