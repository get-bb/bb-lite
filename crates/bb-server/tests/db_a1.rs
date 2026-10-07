use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use bb_server::db::hosts::*;
use bb_server::db::order_keys::*;
use bb_server::db::plugins::*;
use bb_server::db::settings::*;
use bb_server::db::terminals::*;
use bb_server::db::thread_sections::*;
use bb_server::db::{Db, OnConflict, insert_row};
use bb_server::domain::host::{HostType, MachinePhase, PermissionMode};
use bb_server::domain::settings::*;
use bb_server::domain::terminal::{TerminalSessionCloseReason, TerminalSessionStatus};
use bb_server::row;
use serde_json::json;

fn open() -> (Db, Arc<AtomicI64>) {
    let clock = Arc::new(AtomicI64::new(1_000));
    let now = clock.clone();
    let db = Db::open_in_memory(Some(Arc::new(move || now.load(Ordering::SeqCst)))).unwrap();
    (db, clock)
}

fn new_host(id: &str, phase: MachinePhase, launch_key: Option<&str>) -> NewHost {
    NewHost {
        id: id.to_owned(),
        name: format!("Host {id}"),
        phase,
        status_message: None,
        launch_key: launch_key.map(str::to_owned),
    }
}

#[test]
fn hosts_enroll_look_up_and_destroy() {
    let (db, clock) = open();
    insert_host(&db, &new_host("host_a", MachinePhase::Creating, Some("launch-1"))).unwrap();
    insert_host(&db, &new_host("host_a", MachinePhase::Active, None)).unwrap();
    clock.store(2_000, Ordering::SeqCst);
    insert_host(&db, &new_host("host_b", MachinePhase::Active, None)).unwrap();

    let by_key = find_host(&db, HostLookup::LaunchKey, "launch-1").unwrap().unwrap();
    assert_eq!((by_key.id.as_str(), by_key.phase), ("host_a", MachinePhase::Creating));
    assert_eq!(by_key.host_type, HostType::Persistent);
    assert_eq!(by_key.max_permission_mode, PermissionMode::Full);
    assert_eq!(find_host_name(&db, "host_b").unwrap().as_deref(), Some("Host host_b"));
    assert_eq!(find_host_name(&db, "host_gone").unwrap(), None);

    let ids = |filter| -> Vec<String> {
        list_hosts(&db, filter).unwrap().into_iter().map(|host| host.id).collect()
    };
    assert_eq!(ids(HostFilter::default()), ["host_b"]);
    let all = HostFilter { include_creating: true, host_type: None };
    assert_eq!(ids(all), ["host_a", "host_b"]);
    let ephemeral = HostFilter { include_creating: true, host_type: Some(HostType::Ephemeral) };
    assert!(ids(ephemeral).is_empty());

    let patch = row! {
        "phase" => "active",
        "tokenHash" => "hash-1",
        "joinTokenHash" => "join-1",
        "joinExpiresAt" => 5_000,
        "lastInstanceId" => "inst_1",
    };
    clock.store(3_000, Ordering::SeqCst);
    update_host(&db, "host_a", &patch).unwrap();
    let joined = find_host(&db, HostLookup::JoinTokenHash, "join-1").unwrap().unwrap();
    assert_eq!((joined.updated_at, joined.join_expires_at), (3_000, Some(5_000)));

    advance_host_event_cursor(&db, "host_a", "inst_1", 7).unwrap();
    advance_host_event_cursor(&db, "host_a", "inst_1", 3).unwrap();
    advance_host_event_cursor(&db, "host_a", "inst_other", 99).unwrap();
    let host = find_host(&db, HostLookup::TokenHash, "hash-1").unwrap().unwrap();
    assert_eq!(host.last_event_seq, 7);

    let api = to_host(&host, HostState { connected: true, local: false });
    let value = serde_json::to_value(&api).unwrap();
    assert_eq!(
        value,
        json!({
            "id": "host_a", "name": "Host host_a", "type": "persistent", "status": "connected",
            "machineProviderId": "manual",
            "lifecycle": {
                "phase": "active", "suspendedAt": null, "message": null, "pendingLog": "",
                "teardown": null
            },
            "maxPermissionMode": "full", "lastSeenAt": null, "lastRejectedProtocolVersion": null,
            "createdAt": 1_000, "updatedAt": 3_000
        })
    );
    let local = to_host(&host, HostState { connected: false, local: true });
    assert_eq!(local.machine_provider_id, None);

    destroy_host(&db, "host_a").unwrap();
    assert!(find_host(&db, HostLookup::Id, "host_a").unwrap().is_none());
    assert!(find_host(&db, HostLookup::TokenHash, "hash-1").unwrap().is_none());
    let cleared: Option<i64> = db
        .scalar(
            "SELECT COUNT(*) FROM hosts WHERE id = 'host_a' AND phase = 'destroyed'
             AND token_hash IS NULL AND join_token_hash IS NULL AND launch_key IS NULL
             AND destroyed_at IS NOT NULL",
            [],
        )
        .unwrap();
    assert_eq!(cleared, Some(1));
    assert_eq!(find_host_name(&db, "host_a").unwrap().as_deref(), Some("Host host_a"));
}

fn insert_thread(db: &Db, id: &str) {
    let project = row! { "id" => "proj_1", "name" => "P", "createdAt" => 1, "updatedAt" => 1 };
    insert_row(db, "projects", &project, OnConflict::Ignore).unwrap();
    let thread = row! {
        "id" => id, "projectId" => "proj_1", "providerId" => "codex",
        "latestAttentionAt" => 1, "createdAt" => 1, "updatedAt" => 1,
    };
    insert_row(db, "threads", &thread, OnConflict::Fail).unwrap();
}

#[test]
fn sections_keep_names_unique_and_unsection_threads_on_delete() {
    let (db, clock) = open();
    let later = create_thread_section(&db, "Later").unwrap();
    assert_eq!(later.name, "Later");
    assert!(later.id.starts_with("sec_"));
    let conflict = create_thread_section(&db, "Later").unwrap_err();
    assert_eq!(
        (conflict.status, conflict.code(), conflict.to_string().as_str()),
        (409, "section_name_conflict", "Section name already exists")
    );
    let soon = create_thread_section(&db, "Soon").unwrap();
    assert_eq!(rename_thread_section(&db, &soon.id, "Later").unwrap_err().status, 409);
    let missing = rename_thread_section(&db, "sec_gone", "Never").unwrap_err();
    assert_eq!((missing.status, missing.code()), (404, "section_not_found"));
    clock.store(2_000, Ordering::SeqCst);
    let renamed = rename_thread_section(&db, &later.id, "Someday").unwrap();
    assert_eq!(
        serde_json::to_value(&renamed).unwrap(),
        json!({ "id": later.id, "name": "Someday", "updatedThreadCount": 0 })
    );
    let same = rename_thread_section(&db, &later.id, "Someday").unwrap();
    assert_eq!(same.updated_thread_count, 0);
    assert_eq!(require_thread_section(&db, &later.id).unwrap().updated_at, 2_000);

    insert_thread(&db, "thr_1");
    db.run("UPDATE threads SET section_id = ?", [&later.id]).unwrap();
    clock.store(3_000, Ordering::SeqCst);
    let removed = delete_thread_section(&db, &later.id).unwrap();
    assert_eq!(removed.updated_thread_count, 1);
    assert_eq!(removed.name, "Someday");
    assert_eq!(
        removed.threads,
        [SectionThread { id: "thr_1".into(), project_id: "proj_1".into() }]
    );
    assert_eq!(removed.response().updated_thread_count, 1);
    let unsectioned: Option<i64> = db
        .scalar("SELECT COUNT(*) FROM threads WHERE section_id IS NULL AND updated_at = 3000", [])
        .unwrap();
    assert_eq!(unsectioned, Some(1));
    let names: Vec<String> =
        list_thread_sections(&db).unwrap().into_iter().map(|section| section.name).collect();
    assert_eq!(names, ["Soon"]);
    assert_eq!(delete_thread_section(&db, &later.id).unwrap_err().status, 404);
}

#[test]
fn terminals_insert_select_and_update() {
    let (db, clock) = open();
    insert_host(&db, &new_host("host_a", MachinePhase::Active, None)).unwrap();
    let terminal = NewTerminal {
        thread_id: None,
        environment_id: None,
        host_id: "host_a".into(),
        title: "Shell".into(),
        initial_cwd: "/tmp".into(),
        cols: 80,
        rows: 24,
    };
    let stored = insert_terminal(&db, &terminal).unwrap();
    assert!(stored.id.starts_with("term_"));
    assert_eq!(stored.status, TerminalSessionStatus::Starting);
    clock.store(2_000, Ordering::SeqCst);
    let second = insert_terminal(&db, &terminal).unwrap();
    let all = select_terminals(&db, "host_id = ?", ["host_a"]).unwrap();
    assert_eq!(all.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), [&stored.id, &second.id]);

    let patch = row! { "status" => "exited", "exitCode" => 0, "closeReason" => "process-exit" };
    clock.store(3_000, Ordering::SeqCst);
    let exited = update_terminal(&db, &stored.id, &patch).unwrap().unwrap();
    assert_eq!(exited.close_reason, Some(TerminalSessionCloseReason::ProcessExit));
    assert_eq!((exited.exit_code, exited.updated_at), (Some(0), 3_000));
    let value = serde_json::to_value(&exited).unwrap();
    let keys: Vec<&str> = value.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        [
            "id",
            "threadId",
            "environmentId",
            "hostId",
            "title",
            "initialCwd",
            "cols",
            "rows",
            "status",
            "exitCode",
            "closeReason",
            "createdAt",
            "updatedAt",
            "lastUserInputAt"
        ]
    );
    assert_eq!(value["closeReason"], "process-exit");
    assert!(update_terminal(&db, "term_gone", &patch).unwrap().is_none());
    assert!(get_terminal(&db, "term_gone").unwrap().is_none());
}

#[test]
fn plugins_toggle_and_store_rows() {
    let (db, _) = open();
    assert!(is_plugin_enabled(&db, "tasks").unwrap());
    set_plugin_enabled(&db, "tasks", false).unwrap();
    assert!(!is_plugin_enabled(&db, "tasks").unwrap());
    set_plugin_enabled(&db, "tasks", true).unwrap();
    assert!(is_plugin_enabled(&db, "tasks").unwrap());

    let table = PluginRowTable::PluginKv;
    write_plugin_row(&db, table, "tasks", "b:2", Some("two")).unwrap();
    write_plugin_row(&db, table, "tasks", "a:1", Some("one")).unwrap();
    write_plugin_row(&db, table, "tasks", "a:1", Some("uno")).unwrap();
    write_plugin_row(&db, table, "other", "a:9", Some("x")).unwrap();
    let rows = read_plugin_rows(&db, table, "tasks", "").unwrap();
    assert_eq!(
        rows.into_iter().collect::<Vec<_>>(),
        [("a:1".to_owned(), "uno".to_owned()), ("b:2".to_owned(), "two".to_owned())]
    );
    let prefixed = read_plugin_rows(&db, table, "tasks", "b:").unwrap();
    assert_eq!(prefixed.keys().collect::<Vec<_>>(), ["b:2"]);
    write_plugin_row(&db, table, "tasks", "a:1", None).unwrap();
    assert_eq!(read_plugin_rows(&db, table, "tasks", "").unwrap().len(), 1);
    let settings = read_plugin_rows(&db, PluginRowTable::PluginSettings, "tasks", "").unwrap();
    assert!(settings.is_empty());
}

fn store(db: &Db, key: &str, value: serde_json::Value) {
    let row = row! { "key" => key, "value" => value.to_string(), "updatedAt" => 1 };
    insert_row(db, "settings", &row, OnConflict::Update(&["key"])).unwrap();
}

#[test]
fn settings_read_leniently_with_defaults() {
    let (db, _) = open();
    assert_eq!(get_app_settings(&db).unwrap(), AppSettings::default());
    assert_eq!(read_setting(&db, &APPEARANCE_SETTING).unwrap(), AppTheme::default());
    assert!(read_setting(&db, &KEYBINDING_OVERRIDES_SETTING).unwrap().is_empty());

    store(&db, "general", json!({ "streamerMode": true, "retiredSetting": 3 }));
    let settings = get_app_settings(&db).unwrap();
    assert!(settings.streamer_mode);
    assert_eq!(settings, AppSettings { streamer_mode: true, ..AppSettings::default() });

    store(&db, "general", json!({ "streamerMode": true, "managedBranchPrefix": "bad..x" }));
    assert_eq!(get_app_settings(&db).unwrap(), AppSettings::default());
    store(&db, "general", json!({ "machineServerUrl": "ftp://example.com" }));
    assert_eq!(get_app_settings(&db).unwrap(), AppSettings::default());
    store(&db, "general", json!({ "machineServerUrl": "https://example.com/bb" }));
    let url = get_app_settings(&db).unwrap().machine_server_url;
    assert_eq!(url.as_deref(), Some("https://example.com/bb"));

    let mut custom = AppSettings { telemetry_enabled: false, ..AppSettings::default() };
    custom.provider_completed_turn_display.insert("codex".into(), CompletedTurnDisplay::Flat);
    set_app_settings(&db, &custom).unwrap();
    assert_eq!(get_app_settings(&db).unwrap(), custom);
    let keys: Vec<String> = serde_json::to_value(get_app_settings(&db).unwrap())
        .unwrap()
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    assert_eq!(keys.last().map(String::as_str), Some("machineGitCredentialsEnabled"));

    store(&db, "appearance", json!({ "themeId": "dusk", "faviconColor": "mauve" }));
    assert_eq!(read_setting(&db, &APPEARANCE_SETTING).unwrap(), AppTheme::default());
    let theme = AppTheme { theme_id: "dusk".into(), favicon_color: FaviconColorPreference::Teal };
    write_setting(&db, &APPEARANCE_SETTING, &theme).unwrap();
    assert_eq!(read_setting(&db, &APPEARANCE_SETTING).unwrap(), theme);
}

#[test]
fn keeps_stored_keybinding_overrides_whose_command_still_exists() {
    let (db, _) = open();
    let shortcut = json!({ "key": "k", "mod": true, "meta": false, "control": false,
        "alt": false, "shift": true });
    let kept = json!({ "command": "thread.new", "shortcut": null });
    let removed = json!({ "command": "plugins.enterSafeMode", "shortcut": shortcut });
    let plugin = json!({ "command": "plugin:tasks/open", "shortcut": shortcut, "platform": "mac" });
    store(&db, "keybindingOverrides", json!([removed, kept, plugin, { "command": "thread.new" }]));
    let overrides = read_setting(&db, &KEYBINDING_OVERRIDES_SETTING).unwrap();
    assert_eq!(serde_json::to_value(&overrides).unwrap(), json!([kept, plugin]));
    store(&db, "keybindingOverrides", json!({ "not": "an array" }));
    assert!(read_setting(&db, &KEYBINDING_OVERRIDES_SETTING).unwrap().is_empty());
}

#[test]
fn ui_preferences_ignore_undefined_keys_and_map_legacy_values() {
    let stored = vec![
        ("sidebar.navigationProvider".to_owned(), 3, json!("__builtin__")),
        ("sidebar.headerProvider".to_owned(), 2, json!(7)),
        ("sidebar.retired".to_owned(), 9, json!("x")),
    ];
    let entries = ui_preference_entries(&stored);
    assert_eq!(
        serde_json::to_value(&entries).unwrap(),
        json!({
            "sidebar.navigationProvider": { "revision": 3, "value": "navigation/navigation" },
            "sidebar.headerProvider": { "revision": 2, "value": "__builtin__" },
            "sidebar.threadListProvider": { "revision": 0, "value": "__automatic__" },
        })
    );
    assert!(!is_ui_preference_key("sidebar.retired"));
    assert_eq!(get_ui_preference_default("sidebar.retired"), None);
    assert_eq!(
        parse_ui_preference_value("sidebar.headerProvider", &json!("")).unwrap_err(),
        "Too small: expected string to have >=1 characters"
    );
}

#[test]
fn order_keys_sort_between_neighbours() {
    let first = order_key_between(None, None).unwrap();
    assert_eq!(first, "U");
    let before = order_key_between(None, Some(&first)).unwrap();
    let after = order_key_between(Some(&first), None).unwrap();
    assert!(before < first && first < after);
    let between = order_key_between(Some("A"), Some("B")).unwrap();
    assert!("A" < between.as_str() && between.as_str() < "B");
    assert_eq!(order_key_between(Some("B"), Some("A")), Err(OrderKeyError::NotAscending));
    assert_eq!(
        order_key_between(Some("A!"), Some("B")).unwrap_err().to_string(),
        "Invalid order key 'A!'"
    );
}
