use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use bb_server::config::ServerConfig;
use bb_server::context::{Ctx, ServerContext};
use bb_server::db::Db;
use bb_server::db::settings::{get_app_settings, set_app_settings};
use bb_server::http::routes::providers::provider_routes;
use bb_server::log::{LogLevel, Logger};
use bb_server::plugins::host::{PluginHost, PluginHostOptions};
use bb_server::providers::catalog::{
    enable_dev_providers_for_tests, find_provider_definition, list_enabled_providers,
    list_provider_catalog, list_provider_definitions, set_provider_enabled,
};
use bb_server::providers::settings::{provider_options_for, update_provider_settings};
use bb_server::runners::registry::RunnerRegistry;
use bb_server::ws::hub::Hub;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tower::ServiceExt;

const CODEX_INFO: &str = r#"{"id":"codex","pluginId":"provider-codex","displayName":"Codex","available":true,"maintenance":{"health":true,"usage":true,"installation":true},"logoUrl":"/api/v1/system/providers/codex/logo?h=688b78b75ffe1a5c","capabilities":{"supportsThreadArchive":true,"supportsThreadRename":true,"supportsServiceTier":true,"supportsNativeUserQuestion":false,"supportsSessionRewind":true,"permissionModes":["accept-edits","auto","full"],"modelCatalogScope":"host"},"composerActions":[{"kind":"skills","trigger":"/"},{"kind":"skills","trigger":"$"},{"kind":"goal","command":{"trigger":"/","name":"goal","trailingText":" "}}],"completedTurnDisplay":"collapse","reasoningLevels":[{"id":"low","label":"Low"},{"id":"medium","label":"Medium"},{"id":"high","label":"High"},{"id":"xhigh","label":"Extra High"},{"id":"max","label":"Max"},{"id":"ultra","label":"Ultra","description":"Max effort plus automatic task delegation."}],"strings":{"signInHint":"Run `codex` on the machine to sign in.","expiredHint":"Your Codex session expired. Run `codex`, then reload.","installUrl":"https://developers.openai.com/codex/cli","brandPrefix":"GPT-"},"serviceTiers":[{"id":"default","label":"Default"},{"id":"fast","label":"Fast"}],"extensionKinds":{"provider-codex/goal":{"item":false,"state":true},"provider-codex/macos-permission":{"item":true,"state":false}}}"#;
const CLAUDE_CODE_INFO: &str = r##"{"id":"claude-code","pluginId":"provider-claude-code","displayName":"Claude Code","available":true,"maintenance":{"health":true,"usage":true,"installation":true},"logoUrl":"/api/v1/system/providers/claude-code/logo?h=138a999a87258575","capabilities":{"supportsThreadArchive":false,"supportsThreadRename":false,"supportsServiceTier":true,"supportsNativeUserQuestion":true,"supportsSessionRewind":true,"permissionModes":["accept-edits","auto","full"],"modelCatalogScope":"host"},"composerActions":[{"kind":"skills","trigger":"/"},{"kind":"skills","trigger":"$"}],"completedTurnDisplay":"flat","reasoningLevels":[{"id":"low","label":"Low"},{"id":"medium","label":"Medium"},{"id":"high","label":"High"},{"id":"xhigh","label":"Extra High"},{"id":"ultracode","label":"Ultracode","description":"Extra-high effort plus standing workflow orchestration."},{"id":"max","label":"Max"}],"strings":{"signInHint":"Run `claude` on the machine to sign in.","expiredHint":"Your Claude session expired. Run `claude`, then reload.","installUrl":"https://claude.com/claude-code","brandPrefix":"Claude ","iconTint":{"light":"#D97757","dark":"#D97757"}},"serviceTiers":[{"id":"default","label":"Default"},{"id":"fast","label":"Fast","description":"Faster responses on supported Opus models at a higher cost per token."}]}"##;
const ECHO_INFO: &str = r#"{"id":"echo","pluginId":"provider-echo","displayName":"Echo","available":true,"maintenance":{"health":true,"usage":true,"installation":true},"logoUrl":null,"capabilities":{"supportsThreadArchive":false,"supportsThreadRename":false,"supportsServiceTier":false,"supportsNativeUserQuestion":false,"supportsSessionRewind":false,"permissionModes":["accept-edits","auto","full"],"modelCatalogScope":"host"},"composerActions":[{"kind":"skills","trigger":"/"},{"kind":"skills","trigger":"$"}],"completedTurnDisplay":"collapse","reasoningLevels":[{"id":"low","label":"Low"},{"id":"medium","label":"Medium"},{"id":"high","label":"High"}]}"#;

fn context() -> Ctx {
    enable_dev_providers_for_tests();
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
        host_id: "host_local".into(),
        log_level: LogLevel::Silent,
    };
    let db = Db::open_in_memory(None).unwrap();
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
        runners: RunnerRegistry::new("host_local", log.clone()),
        plugins,
        log,
        engine: Default::default(),
        environments: Default::default(),
        terminals: Default::default(),
    })
}

async fn send(ctx: &Ctx, method: &str, uri: &str, body: Option<&str>) -> axum::response::Response {
    let request = Request::builder().method(method).uri(uri);
    let request = match body {
        Some(body) => {
            request.header("content-type", "application/json").body(Body::from(body.to_string()))
        }
        None => request.body(Body::empty()),
    };
    provider_routes().with_state(ctx.clone()).oneshot(request.unwrap()).await.unwrap()
}

async fn json_of(response: axum::response::Response) -> (StatusCode, Value) {
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}

fn ids(values: &Value) -> Vec<&str> {
    values.as_array().unwrap().iter().map(|entry| entry["id"].as_str().unwrap()).collect()
}

#[test]
fn built_in_provider_info_matches_the_typescript_catalog() {
    let ctx = context();
    let infos: Vec<Value> = list_provider_definitions(&ctx.db)
        .unwrap()
        .into_iter()
        .map(|provider| serde_json::to_value(provider.info).unwrap())
        .collect();
    let expected: Vec<Value> = [CODEX_INFO, CLAUDE_CODE_INFO, ECHO_INFO]
        .iter()
        .map(|info| serde_json::from_str(info).unwrap())
        .collect();
    assert_eq!(infos, expected);
    assert_eq!(serde_json::to_string(&infos[0]).unwrap(), CODEX_INFO);
    let catalog = serde_json::to_value(list_provider_catalog(&ctx.db).unwrap()).unwrap();
    assert_eq!(
        catalog[1],
        json!({
            "id": "claude-code", "displayName": "Claude Code", "pluginId": "provider-claude-code",
            "pluginName": "Claude Code provider", "pluginEnabled": true, "enabled": true,
            "available": true, "logoUrl": "/api/v1/system/providers/claude-code/logo?h=138a999a87258575",
            "info": expected[1],
        })
    );
}

#[test]
fn orders_by_settings_and_clears_a_disabled_default() {
    let ctx = context();
    let mut settings = get_app_settings(&ctx.db).unwrap();
    settings.provider_order = vec!["echo".into(), "claude-code".into()];
    settings.default_provider_id = Some("claude-code".into());
    set_app_settings(&ctx.db, &settings).unwrap();
    let order: Vec<_> =
        list_provider_definitions(&ctx.db).unwrap().iter().map(|p| p.id.as_str()).collect();
    assert_eq!(order, ["echo", "claude-code", "codex"]);
    set_provider_enabled(&ctx.db, "claude-code", false).unwrap();
    let enabled: Vec<_> =
        list_enabled_providers(&ctx.db).unwrap().iter().map(|p| p.id.as_str()).collect();
    assert_eq!(enabled, ["echo", "codex"]);
    assert_eq!(get_app_settings(&ctx.db).unwrap().default_provider_id, None);
    set_provider_enabled(&ctx.db, "claude-code", true).unwrap();
    assert_eq!(list_enabled_providers(&ctx.db).unwrap().len(), 3);
    assert!(find_provider_definition(&ctx.db, "nope").is_none());
}

#[tokio::test]
async fn disables_providers_and_turns_their_toggles_into_options() {
    let ctx = context();
    let changes = Arc::new(Mutex::new(Vec::<Value>::new()));
    let seen = changes.clone();
    let _guard =
        ctx.hub.on_changed(move |message| seen.lock().push(serde_json::to_value(message).unwrap()));
    let config_changed =
        json!({"type": "changed", "entity": "system", "changes": ["config-changed"]});

    let off =
        send(&ctx, "PUT", "/system/providers/codex/enabled", Some(r#"{"enabled":false}"#)).await;
    let (status, catalog) = json_of(off).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        (catalog[0]["enabled"].clone(), catalog[0]["pluginId"].clone()),
        (json!(false), json!("provider-codex"))
    );
    assert_eq!(changes.lock().drain(..).collect::<Vec<_>>(), std::slice::from_ref(&config_changed));
    let (_, listed) =
        json_of(send(&ctx, "GET", "/system/providers?capability=usage", None).await).await;
    assert_eq!(ids(&listed), ["claude-code", "echo"]);

    let unknown =
        send(&ctx, "PUT", "/system/providers/nope/enabled", Some(r#"{"enabled":true}"#)).await;
    let (status, error) = json_of(unknown).await;
    assert_eq!(
        (status, error["code"].clone()),
        (StatusCode::NOT_FOUND, json!("provider_not_found"))
    );
    let strict =
        send(&ctx, "PUT", "/system/providers/codex/enabled", Some(r#"{"enabled":true,"x":1}"#))
            .await;
    assert_eq!(strict.status(), StatusCode::BAD_REQUEST);

    let logo = send(&ctx, "GET", "/system/providers/claude-code/logo", None).await;
    assert_eq!(logo.headers()["content-type"], "image/svg+xml");
    assert_eq!(logo.headers()["cache-control"], "no-cache");
    let pinned = send(&ctx, "GET", "/system/providers/codex/logo?h=688b78b75ffe1a5c", None).await;
    assert_eq!(pinned.headers()["cache-control"], "public, max-age=31536000, immutable");
    let (status, error) =
        json_of(send(&ctx, "GET", "/system/providers/echo/logo", None).await).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error["message"], "Provider 'echo' has no logo.");

    let defaults = json!({"memoryEnabled": true, "providerSubagentsEnabled": true});
    assert_eq!(Value::Object(provider_options_for(&ctx.db, "codex").unwrap()), defaults);
    let body = r#"{"values":{"subagentsDisabled":true}}"#;
    let saved = send(&ctx, "PUT", "/plugins/provider-codex/settings", Some(body)).await;
    let (status, view) = json_of(saved).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["ok"], true);
    assert_eq!(view["values"], json!({"memoryEnabled": true, "subagentsDisabled": true}));
    assert_eq!(
        view["schema"]["subagentsDisabled"],
        json!({"type": "boolean", "label": "Disable provider subagents", "description": "Prevent Codex from starting native subagents so agents use bb for delegation.", "default": false})
    );
    assert_eq!(changes.lock().drain(..).collect::<Vec<_>>(), [config_changed]);
    let updated = json!({"memoryEnabled": true, "providerSubagentsEnabled": false});
    assert_eq!(Value::Object(provider_options_for(&ctx.db, "codex").unwrap()), updated);

    let (status, error) =
        json_of(send(&ctx, "PUT", "/plugins/provider-codex/settings", Some("{}")).await).await;
    assert_eq!(
        (status, error["message"].clone()),
        (StatusCode::BAD_REQUEST, json!("Expected { values: Record<string, unknown> }"))
    );
    let wrong = r#"{"values":{"memoryEnabled":"yes"}}"#;
    let (_, error) =
        json_of(send(&ctx, "PUT", "/plugins/provider-claude-code/settings", Some(wrong)).await)
            .await;
    assert_eq!(error["message"], "Setting 'memoryEnabled' must be true or false");
    let mut values = serde_json::Map::new();
    values.insert("bogus".into(), json!(true));
    let error = update_provider_settings(&ctx.db, "claude-code", &values).unwrap_err();
    assert_eq!(error.body.message, "Unknown setting 'bogus'");
    let claude = json!({"memoryEnabled": true, "providerSubagentsEnabled": true, "workflowsEnabled": true, "disable1MContext": false, "chromeEnabled": false});
    assert_eq!(Value::Object(provider_options_for(&ctx.db, "claude-code").unwrap()), claude);
    assert!(provider_options_for(&ctx.db, "echo").unwrap().is_empty());
}
