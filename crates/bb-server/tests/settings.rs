use std::path::Path;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use bb_server::config::ServerConfig;
use bb_server::context::{Ctx, ServerContext};
use bb_server::db::Db;
use bb_server::domain::changes::{ChangedMessage, SystemChangeKind};
use bb_server::domain::settings::{AppSettings, UI_PREFERENCE_KEYS};
use bb_server::http::routes::settings::register_settings_routes;
use bb_server::http::trust::Principal;
use bb_server::log::{LogLevel, Logger};
use bb_server::machine_environment::{KEY_FILE, decrypt, encrypt, resolve_contributed_environment};
use bb_server::plugins::host::{PluginHost, PluginHostOptions};
use bb_server::runners::registry::RunnerRegistry;
use bb_server::settings::keybindings::{
    DEFAULT_APP_KEYBINDINGS, apply_app_keybinding_overrides, parse_app_keybinding_overrides,
};
use bb_server::ws::hub::Hub;
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tower::ServiceExt;

struct World {
    ctx: Ctx,
    app: Router,
    changes: Arc<Mutex<Vec<SystemChangeKind>>>,
    _guard: Box<dyn std::any::Any>,
    _dir: tempfile::TempDir,
}

fn world() -> World {
    let dir = tempfile::tempdir().unwrap();
    let db = Db::open_in_memory(None).unwrap();
    db.run("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('prj', 'a', 1, 1)", [])
        .unwrap();
    let config = ServerConfig {
        data_dir: dir.path().to_path_buf(),
        port: 0,
        bind_host: "127.0.0.1".into(),
        allowed_hosts: vec![],
        app_dir: Default::default(),
        cli_dir: Default::default(),
        bb_cli_path: Default::default(),
        version: "test".into(),
        host_id: "hst_local".into(),
        log_level: LogLevel::Warn,
    };
    let hub = Hub::new();
    let log = Logger::silent();
    let plugins = PluginHost::new(PluginHostOptions {
        config: config.clone(),
        db: db.clone(),
        hub: hub.clone(),
        log: log.clone(),
        builtins: Some(vec![]),
    });
    let ctx = Arc::new(ServerContext {
        config,
        db,
        hub,
        runners: RunnerRegistry::new("hst_local", log.clone()),
        plugins,
        log,
        engine: Default::default(),
        environments: Default::default(),
        terminals: Default::default(),
    });
    let changes: Arc<Mutex<Vec<SystemChangeKind>>> = Arc::default();
    let sink = changes.clone();
    let guard = ctx.hub.on_changed(move |message| {
        if let ChangedMessage::System { changes } = message {
            sink.lock().extend(changes.iter().copied());
        }
    });
    let app = register_settings_routes().with_state(ctx.clone());
    World { ctx, app, changes, _guard: Box::new(guard), _dir: dir }
}

impl World {
    async fn send(&self, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        let mut request = Request::builder().method(method).uri(path).header("host", "bb.test");
        if body.is_some() {
            request = request.header("content-type", "application/json");
        }
        let body = body.map_or(Body::empty(), |value| Body::from(value.to_string()));
        let mut request = request.body(body).unwrap();
        request.extensions_mut().insert(Principal::Owner);
        let response = self.app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    fn take_changes(&self) -> Vec<SystemChangeKind> {
        std::mem::take(&mut *self.changes.lock())
    }
}

#[tokio::test]
async fn guards_ui_preferences_with_per_key_revisions() {
    let world = world();
    let key = "sidebar.headerProvider";
    let sql = "INSERT INTO ui_preferences (key, value_json, revision, updated_at)
      VALUES ('sidebar.organizationMode', '\"machine\"', 3, 1)";
    world.ctx.db.run(sql, []).unwrap();
    let (_, body) = world.send("GET", "/preferences/ui", None).await;
    let preferences = body["preferences"].as_object().unwrap();
    let keys: Vec<&str> = preferences.keys().map(String::as_str).collect();
    assert_eq!(keys, UI_PREFERENCE_KEYS);
    let default = preferences[key]["value"].clone();
    assert_eq!(preferences[key]["revision"], 0);

    let path = format!("/preferences/ui/{key}");
    let write = |revision: i64, value: &str| {
        let body = json!({ "expectedRevision": revision, "value": value });
        world.send("PUT", &path, Some(body))
    };
    let (status, saved) = write(0, "nav/header").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved, json!({ "key": key, "revision": 1, "value": "nav/header" }));
    assert_eq!(world.take_changes(), [SystemChangeKind::UiPreferencesChanged]);
    let (status, conflict) = write(0, "other").await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(conflict["code"], "ui_preference_conflict");
    assert_eq!(conflict["details"], json!({ "currentRevision": 1 }));
    assert!(world.take_changes().is_empty());

    let (_, reset) = world.send("DELETE", &path, None).await;
    assert_eq!(reset, json!({ "key": key, "revision": 2, "value": default }));
    let (status, unknown) = world.send("DELETE", "/preferences/ui/nope", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(unknown["code"], "ui_preference_not_found");
    let body = json!({ "expectedRevision": 2, "value": 5 });
    let (status, invalid) = world.send("PUT", &path, Some(body)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let message = invalid["message"].as_str().unwrap();
    assert!(message.starts_with("Invalid value for UI preference 'sidebar.headerProvider': "));
}

#[tokio::test]
async fn announces_settings_writes_and_serves_the_config() {
    let world = world();
    let mut settings = serde_json::to_value(AppSettings::default()).unwrap();
    settings["steerActiveThreadOnEnter"] = json!(false);
    let (status, saved) = world.send("PUT", "/settings/general", Some(settings)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["steerActiveThreadOnEnter"], false);
    assert_eq!(world.take_changes(), [SystemChangeKind::ConfigChanged]);
    let (status, _) = world.send("PUT", "/settings/general", Some(json!({}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (_, config) = world.send("GET", "/system/config", None).await;
    assert_eq!(config["generalSettings"]["steerActiveThreadOnEnter"], false);
    assert!(config["keybindings"].as_array().unwrap().len() > 40);
    assert_eq!(config["serverUrl"], "http://bb.test");
    assert_eq!(config["primaryHostId"], "hst_local");
    assert_eq!(config["serverAccess"]["providers"][0]["id"], "direct");
    assert_eq!(config["featureFlags"]["timelineWindowEventBudget"], 1500);
    assert_eq!(config["appearance"], json!({ "themeId": "default", "faviconColor": "default" }));
}

#[tokio::test]
async fn keeps_stored_keybinding_overrides_whose_command_still_exists() {
    let world = world();
    let kept = json!({ "command": "thread.new", "shortcut": null });
    let shortcut = json!({ "key": "k", "mod": true, "meta": false, "control": false,
        "alt": false, "shift": true });
    let removed = json!({ "command": "plugins.enterSafeMode", "shortcut": shortcut });
    let value = json!([removed, kept]).to_string();
    let sql = "INSERT INTO settings (key, value, updated_at) VALUES ('keybindingOverrides', ?, 1)";
    world.ctx.db.run(sql, [value]).unwrap();
    let (_, config) = world.send("GET", "/system/config", None).await;
    assert_eq!(config["keybindingOverrides"], json!([kept]));
    let bound = config["keybindings"].as_array().unwrap();
    assert!(!bound.iter().any(|binding| binding["command"] == "thread.new"));
}

#[tokio::test]
async fn validates_keyboard_and_appearance_settings() {
    let world = world();
    let shortcut = json!({ "key": "n", "mod": true, "meta": false, "control": false,
        "alt": false, "shift": false });
    let overrides = json!([{ "command": "thread.new", "shortcut": shortcut, "platform": "mac" }]);
    let (status, saved) = world.send("PUT", "/settings/keyboard", Some(overrides.clone())).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved, overrides);
    assert_eq!(world.take_changes(), [SystemChangeKind::ConfigChanged]);
    let duplicate = json!([overrides[0], overrides[0]]);
    let (status, refused) = world.send("PUT", "/settings/keyboard", Some(duplicate)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(refused["message"], "Duplicate override for thread.new");

    let (_, config) = world.send("GET", "/system/config", None).await;
    let bound: Vec<&Value> = config["keybindings"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|binding| binding["command"] == "thread.new")
        .collect();
    assert_eq!(bound.len(), 3);
    assert_eq!(bound[0]["shortcut"]["key"], "n");
    assert_eq!(bound[0]["when"]["all"], json!(["mainSurface", "macPlatform"]));
    assert_eq!(bound[1]["shortcut"]["key"], "o");

    let theme = json!({ "themeId": "nord", "faviconColor": "teal" });
    let (status, saved) = world.send("PUT", "/settings/appearance", Some(theme.clone())).await;
    assert_eq!((status, saved), (StatusCode::OK, theme));
    let unknown = json!({ "themeId": "neon", "faviconColor": "teal" });
    let (status, refused) = world.send("PUT", "/settings/appearance", Some(unknown)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(refused["message"], "Unknown theme 'neon'.");
}

#[test]
fn default_keybindings_match_the_typescript_table() {
    assert_eq!(DEFAULT_APP_KEYBINDINGS.len(), 95);
    let text = serde_json::to_string(&*DEFAULT_APP_KEYBINDINGS).unwrap();
    let digest = hex::encode(<sha2::Sha256 as sha2::Digest>::digest(text.as_bytes()));
    assert_eq!(digest, "8d9b16f4439c01719e98f66e0d460553005335770da62ee52522debbe14d7859");
    let first = serde_json::to_value(&DEFAULT_APP_KEYBINDINGS[0]).unwrap();
    let expected = json!({
        "command": "palette.open",
        "shortcut": { "key": "p", "mod": true, "meta": false, "control": false,
            "alt": false, "shift": true },
        "when": { "all": ["mainSurface"], "none": ["modalOpen"] },
    });
    assert_eq!(first, expected);
    let effective = apply_app_keybinding_overrides(&DEFAULT_APP_KEYBINDINGS, &[]);
    let unbound = DEFAULT_APP_KEYBINDINGS.iter().filter(|binding| binding.shortcut.is_none());
    assert_eq!(effective.len(), DEFAULT_APP_KEYBINDINGS.len() - unbound.count());
    assert!(
        parse_app_keybinding_overrides(&json!([{ "command": "nope", "shortcut": null }])).is_err()
    );
}

#[tokio::test]
async fn keeps_environment_variable_values_encrypted_and_write_only() {
    let world = world();
    let set = |value: Option<&str>, name: &str, note: &str| json!({ "variables": [{ "name": name, "value": value, "note": note }] });
    let everywhere = "/settings/machine-environment";
    let scoped = "/projects/prj/machine-environment";
    world.send("PUT", everywhere, Some(set(Some("s3cret-global"), "API_KEY", "n"))).await;
    assert_eq!(world.take_changes(), [SystemChangeKind::ConfigChanged]);
    world.send("PUT", scoped, Some(set(Some("s3cret-own"), "API_KEY", "n"))).await;
    assert_eq!(world.take_changes(), [SystemChangeKind::ConfigChanged]);
    let (_, kept) = world.send("PUT", everywhere, Some(set(None, "API_KEY", "kept"))).await;
    assert_eq!(world.take_changes(), [SystemChangeKind::ConfigChanged]);
    let variables = json!([{ "name": "API_KEY", "value": null, "secret": true, "note": "kept" }]);
    assert_eq!(kept["variables"], variables);
    assert_eq!(kept["builtInGit"]["status"], "disabled");
    let (_, view) = world.send("GET", scoped, None).await;
    assert_eq!(view["inheritedVariables"], variables);
    let (status, _) = world.send("PUT", everywhere, Some(set(None, "OTHER", "n"))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = world.send("GET", "/projects/missing/machine-environment", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    for invalid in [set(Some("x"), "lower", "n"), set(Some("a\0b"), "OK", "n")] {
        let (status, _) = world.send("PUT", everywhere, Some(invalid)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    let twice = json!({ "variables": [
        { "name": "A", "value": "1", "note": null }, { "name": "A", "value": "2", "note": null }] });
    let (status, _) = world.send("PUT", everywhere, Some(twice)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let stored = world.ctx.db.rows("SELECT * FROM environment_variables", []).unwrap();
    assert!(!json!([stored, view]).to_string().contains("s3cret"));
    assert_eq!(key_mode(&world.ctx.config.data_dir.join(KEY_FILE)), 0o600);
    let global = resolve_contributed_environment(&world.ctx, None).await.unwrap();
    let project = resolve_contributed_environment(&world.ctx, Some("prj")).await.unwrap();
    assert_eq!(
        [global["API_KEY"].as_str(), project["API_KEY"].as_str()],
        ["s3cret-global", "s3cret-own"]
    );

    let (_, token) = world.send("PUT", scoped, Some(set(Some("t"), "GH_TOKEN", "n"))).await;
    assert_eq!(token["builtInGit"]["statusMessage"], "Overridden by this project.");
}

#[cfg(unix)]
fn key_mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[cfg(not(unix))]
fn key_mode(_path: &Path) -> u32 {
    0o600
}

/// Produced by `apps/server/src/machine-environment.ts` (`replaceMachineEnvironment`) in a
/// temporary data directory.
const TS_KEY: &str = "316a5086e1f28021a20228488708d211f894c3ee71e64519f3b3c25ce7a1d17a\n";
const TS_ROWS: [(Option<&str>, &str, &str, &str); 3] = [
    (
        None,
        "GH_TOKEN",
        "uhU/9cbrCUIsP0z2gxcIYiCna2CSOPZeYRbRgXjSEyP4LeB1tF6iHMjS",
        "ghp_secret-123",
    ),
    (
        None,
        "UNICODE_VALUE",
        "U+L4+MxM579NGOkdBIaynNmqzCDsKmWj9d/CHmVbK2Ng34HbLK0gy38m7YCW",
        "h\u{e9}llo w\u{f6}rld \u{2713}",
    ),
    (
        Some("prj_interop"),
        "PROJECT_ONLY",
        "B6ZiyZLZvQnQ1iVszL24vXpn7P5HO9TZhIMlsxq3+OicJGfhKWL+",
        "per-project",
    ),
];

#[tokio::test]
async fn decrypts_values_the_typescript_server_encrypted() {
    let world = world();
    std::fs::write(world.ctx.config.data_dir.join(KEY_FILE), TS_KEY).unwrap();
    let mut key = [0u8; 32];
    hex::decode_to_slice(TS_KEY.trim(), &mut key).unwrap();
    for (project_id, name, ciphertext, plain) in TS_ROWS {
        assert_eq!(decrypt(&key, project_id, name, ciphertext).as_deref(), Ok(plain));
        let ours = encrypt(&key, project_id, name, plain);
        let (theirs_raw, ours_raw) = (decode(ciphertext), decode(&ours));
        assert_eq!(ours_raw.len(), theirs_raw.len());
        assert_eq!(ours_raw.len(), 12 + 16 + plain.len());
        assert_ne!(ours, ciphertext);
        assert_eq!(decrypt(&key, project_id, name, &ours).as_deref(), Ok(plain));
    }
    let moved = decrypt(&key, Some("prj_other"), "PROJECT_ONLY", TS_ROWS[2].2);
    let message = "Machine environment variable PROJECT_ONLY cannot be decrypted; \
        restore its encryption key or set it again.";
    assert_eq!(moved, Err(message.to_owned()));

    let sql = "INSERT INTO environment_variables
      (project_id, name, ciphertext, encryption_version, note, updated_at) VALUES (?, ?, ?, 2, NULL, 1)";
    for (project_id, name, ciphertext, _) in &TS_ROWS[..2] {
        world.ctx.db.run(sql, rusqlite_params(*project_id, name, ciphertext)).unwrap();
    }
    let resolved = resolve_contributed_environment(&world.ctx, None).await.unwrap();
    assert_eq!(resolved["GH_TOKEN"], "ghp_secret-123");
    assert_eq!(resolved["UNICODE_VALUE"], TS_ROWS[1].3);
}

fn rusqlite_params<'a>(
    project_id: Option<&'a str>,
    name: &'a str,
    ciphertext: &'a str,
) -> (Option<&'a str>, &'a str, &'a str) {
    (project_id, name, ciphertext)
}

fn decode(text: &str) -> Vec<u8> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(text).unwrap()
}
