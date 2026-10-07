use std::sync::Arc;

use bb_connect::{AccountOptions, ConnectAccount, Link, legacy_link, share_url};

fn link() -> Link {
    Link {
        base_url: "https://example.test:8443".to_string(),
        server_url: "https://bee.example.test:8443".to_string(),
        server_id: "srv_1".to_string(),
        server_label: "bee".to_string(),
        credential: "bbcred_first".to_string(),
    }
}

fn account(file: std::path::PathBuf) -> ConnectAccount {
    let options = AccountOptions::new(
        file,
        "http://127.0.0.1:9".to_string(),
        "test".to_string(),
        Arc::new(|_| {}),
        Arc::new(|| {}),
    );
    ConnectAccount::new(options)
}

#[test]
fn share_url_puts_label_and_port_before_the_account_host() {
    assert_eq!(share_url(&link(), 5173), "https://bee--5173.example.test:8443");
    let local = Link { base_url: "http://localhost:3000/".to_string(), ..link() };
    assert_eq!(share_url(&local, 80), "http://bee--80.localhost:3000");
}

#[cfg(unix)]
#[test]
fn connect_json_is_private_and_reloads() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("connect.json");
    std::fs::write(&file, "{}").unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
    let first = account(file.clone());
    assert_eq!(first.link(), None);
    first.adopt(Some(link())).unwrap();
    let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(text.starts_with("{\n  \"baseUrl\": \"https://example.test:8443\",\n"));
    assert!(text.ends_with("}\n"));
    assert_eq!(account(file.clone()).link(), Some(link()));
    first.adopt(None).unwrap();
    assert!(!file.exists());
    assert_eq!(account(file).link(), None);
}

#[test]
fn legacy_link_reads_the_original_credential_read_only() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("bb.db");
    let database = rusqlite::Connection::open(&path).unwrap();
    database
        .execute_batch("CREATE TABLE plugin_kv (plugin_id TEXT, key TEXT, value TEXT);")
        .unwrap();
    let missing = legacy_link(&path).unwrap_err();
    assert_eq!(missing.to_string(), "that database holds no bb account credential");
    let stored = serde_json::json!({
        "baseUrl": "https://example.test",
        "serverUrl": "https://bee.example.test",
        "serverId": "srv_1",
        "credential": "bbcred_old",
        "extra": true,
    });
    database
        .execute(
            "INSERT INTO plugin_kv VALUES ('bb-account', 'credential', ?1)",
            [stored.to_string()],
        )
        .unwrap();
    drop(database);
    let link = legacy_link(&path).unwrap();
    assert_eq!(link.server_label, "bee");
    assert_eq!(link.credential, "bbcred_old");
    assert!(legacy_link(&dir.path().join("absent.db")).is_err());
    assert!(!dir.path().join("absent.db").exists());
}

#[test]
fn status_json_matches_the_contract() {
    use bb_connect::{ConnectState, ConnectStatus, LoginState, LoginView, PortInput, ShareView};
    let status = ConnectStatus {
        state: ConnectState::Reconnecting,
        paired: true,
        enabled: true,
        handle: Some("bee".to_string()),
        url: None,
        last_error: None,
        next_retry_at: Some(1_700_000_000_000),
        login: Some(LoginView {
            state: LoginState::SignedIn,
            user_code: "BEE-123".to_string(),
            verification_url: "https://example.test/link".to_string(),
            message: None,
        }),
        shares: vec![ShareView { port: 5173, url: None }],
    };
    let expected = r#"{"state":"reconnecting","paired":true,"enabled":true,"handle":"bee","url":null,"lastError":null,"nextRetryAt":1700000000000,"login":{"state":"signed-in","userCode":"BEE-123","verificationUrl":"https://example.test/link","message":null},"shares":[{"port":5173,"url":null}]}"#;
    assert_eq!(serde_json::to_string(&status).unwrap(), expected);
    assert!(serde_json::from_str::<PortInput>(r#"{"port":1,"x":2}"#).is_err());
}
