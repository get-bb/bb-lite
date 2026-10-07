use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;

use bb_pool::contract::*;
use bb_pool::limits::EMPTY_QUOTA;
use bb_pool::store::*;
use serde_json::json;

fn new_account(priority: i64, uuid: Option<&str>) -> NewAccount {
    NewAccount {
        provider: PoolProvider::Claude,
        kind: AccountKind::OAuth,
        label: format!("account {priority}"),
        email: Some("me@example.com".into()),
        account_uuid: uuid.map(str::to_string),
        codex_account_id: None,
        subscription_type: Some("max".into()),
        rate_limit_tier: None,
        enabled: true,
        priority,
    }
}

fn oauth(n: u8) -> AccountSecret {
    AccountSecret::OAuth {
        access_token: format!("access-{n}"),
        refresh_token: format!("refresh-{n}"),
        expires_at: Some(1),
        id_token: None,
    }
}

fn mode(path: &std::path::Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[tokio::test]
async fn account_store_keeps_accounts_in_kv_and_secrets_private() {
    let temp = tempfile::tempdir().unwrap();
    let secrets = temp.path().join("secrets");
    let kv = Arc::new(MemoryKv::new());
    let store = AccountStore::new(kv.clone(), &secrets);
    let second = store.add(new_account(5, None), &oauth(2)).await.unwrap();
    let first = store
        .add(new_account(1, None), &AccountSecret::ApiKey { api_key: "sk".into() })
        .await
        .unwrap();
    assert!(is_uuid(&first.id) && first.created_at > 0 && first.last_used_at.is_none());
    let ids: Vec<String> = store.list().await.unwrap().into_iter().map(|a| a.id).collect();
    assert_eq!(ids, [first.id.clone(), second.id.clone()]);
    let file = secrets.join(format!("account-{}.json", second.id));
    assert_eq!((mode(&secrets), mode(&file)), (0o700, 0o600));
    let text = std::fs::read_to_string(&file).unwrap();
    assert_eq!(
        text,
        "{\"kind\":\"oauth\",\"accessToken\":\"access-2\",\"refreshToken\":\"refresh-2\",\"expiresAt\":1}\n"
    );
    assert_eq!(store.read_secret(&second.id).await.unwrap(), oauth(2));
    assert!(
        std::fs::read_dir(&secrets).unwrap().all(|e| !e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp"))
    );

    let updated = store
        .update(&second.id, |a| {
            a.priority = 0;
            a.enabled = false;
            a.id = "x".into();
        })
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (updated.id.as_str(), updated.priority, updated.enabled),
        (second.id.as_str(), 0, false)
    );
    assert_eq!(store.list().await.unwrap()[0].id, second.id);
    assert!(store.update(&second.id, |a| a.label.clear()).await.is_err());
    assert!(store.update("00000000-0000-4000-8000-000000000009", |_| {}).await.unwrap().is_none());
    let stored = kv.get("accounts:v1").await.unwrap();
    assert_eq!(stored[0]["accountUuid"], json!(null));
    assert!(stored[0].get("codexAccountId").is_none());

    assert!(store.remove(&second.id).await.unwrap());
    assert!(!file.exists());
    assert!(!store.remove(&second.id).await.unwrap());
    assert_eq!(store.list().await.unwrap().len(), 1);
    assert!(store.read_secret("../escape").await.is_err());
    assert!(
        store
            .write_secret(&first.id, &AccountSecret::ApiKey { api_key: String::new() })
            .await
            .is_err()
    );
}

#[tokio::test]
async fn hub_tokens_persist_per_host_and_authenticate() {
    let temp = tempfile::tempdir().unwrap();
    let tokens = HubTokens::new(temp.path());
    let value = tokens.for_host("host_b").await.unwrap();
    assert_eq!(value.len(), 43);
    assert!(value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    assert_eq!(tokens.for_host("host_b").await.unwrap(), value);
    let other = tokens.for_host("host-a").await.unwrap();
    assert!(tokens.for_host("bad host").await.is_err());
    assert_eq!(mode(&temp.path().join("hub-token-host_b.json")), 0o600);
    assert_eq!(tokens.authenticate(Some(&value)).as_deref(), Some("host_b"));
    assert_eq!(tokens.authenticate(Some("wrong")), None);
    assert_eq!(tokens.authenticate(None), None);
    std::fs::write(
        temp.path().join("hub-token-junk.json"),
        "{\"hostId\":\"x\",\"value\":\"short\",\"mintedAt\":1}",
    )
    .unwrap();
    let reloaded = HubTokens::new(temp.path());
    reloaded.load().await;
    assert_eq!(reloaded.host_ids(), ["host-a", "host_b"]);
    assert_eq!(reloaded.authenticate(Some(&other)).as_deref(), Some("host-a"));
}

#[tokio::test]
async fn pool_state_round_trips_and_expires_idle_bindings() {
    let temp = tempfile::tempdir().unwrap();
    let file = temp.path().join("data").join("state.json");
    let state = PoolState::new(&file);
    state.load().await;
    assert_eq!(state.quota("a"), EMPTY_QUOTA);
    let quota = AccountQuota { extra_usage: Some(true), observed_at: Some(5), ..EMPTY_QUOTA };
    state.set_quota("a", Some(quota.clone()));
    state.set_quota("b", Some(quota.clone()));
    state.set_quota("b", None);
    state.bind("session:s1", "a");
    state.set_active(PoolProvider::Codex, "a");
    assert_eq!(state.bound_account(Some("session:s1")).as_deref(), Some("a"));
    assert_eq!(state.bound_account(None), None);
    state.flush().await.unwrap();
    assert_eq!(mode(&file), 0o600);
    let written: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(written["active"], json!({"codex": "a"}));
    assert!(written["bindings"][0][2].is_i64());

    let reloaded = PoolState::new(&file);
    reloaded.load().await;
    assert_eq!(reloaded.quota("a"), quota);
    assert_eq!(reloaded.active(PoolProvider::Codex).as_deref(), Some("a"));
    assert_eq!(reloaded.active(PoolProvider::Claude), None);
    assert_eq!(reloaded.bound_account(Some("session:s1")).as_deref(), Some("a"));

    let stale = now_ms() - AFFINITY_IDLE_TTL_MS - 1;
    let old = json!({"quotas": {}, "bindings": [["session:old", "a", stale]], "active": {}});
    std::fs::write(&file, old.to_string()).unwrap();
    let expired = PoolState::new(&file);
    expired.load().await;
    assert_eq!(expired.bound_account(Some("session:old")), None);
    std::fs::write(&file, "{\"quotas\":{},\"bindings\":[],\"active\":{\"gemini\":\"x\"}}").unwrap();
    let rejected = PoolState::new(&file);
    rejected.load().await;
    assert_eq!(rejected.active(PoolProvider::Claude), None);
}

#[tokio::test(start_paused = true)]
async fn pool_state_flushes_five_seconds_after_a_change() {
    let temp = tempfile::tempdir().unwrap();
    let file = temp.path().join("state.json");
    let state = PoolState::new(&file);
    state.bind("k", "a");
    tokio::time::sleep(std::time::Duration::from_millis(4_900)).await;
    assert!(!file.exists());
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    for _ in 0..200 {
        if file.exists() {
            break;
        }
        tokio::task::yield_now().await;
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert!(file.exists());
}

#[test]
fn contract_json_shapes() {
    let config: PoolConfig = serde_json::from_value(json!({})).unwrap();
    assert_eq!(config, PoolConfig::default());
    assert!(config.validate().is_ok());
    let bad = PoolConfig { codex_auth_base_url: "ftp://x".into(), ..PoolConfig::default() };
    assert!(bad.validate().is_err());
    assert!(ConfigSetInput { switch_threshold: 0.0 }.validate().is_err());
    assert!(ConfigSetInput { switch_threshold: 1.0 }.validate().is_ok());
    let account: Account = serde_json::from_value(json!({
        "id": "00000000-0000-4000-8000-000000000001", "provider": "codex", "kind": "api-key",
        "label": "one", "email": null, "subscriptionType": null, "rateLimitTier": null,
        "enabled": true, "priority": 0, "createdAt": 1
    }))
    .unwrap();
    assert!(account.validate().is_ok());
    let summary = AccountSummary {
        account: account.clone(),
        quota: EMPTY_QUOTA,
        in_flight: 0,
        status: AccountStatus::Ready,
        blocked_until: None,
    };
    let keys: Vec<String> =
        serde_json::to_value(&summary).unwrap().as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        keys,
        [
            "id",
            "provider",
            "kind",
            "label",
            "email",
            "accountUuid",
            "subscriptionType",
            "rateLimitTier",
            "enabled",
            "priority",
            "createdAt",
            "lastUsedAt",
            "lastUsedHostId",
            "windows",
            "extraUsage",
            "observedAt",
            "heldUntil",
            "error",
            "inFlight",
            "status",
            "blockedUntil"
        ]
    );
    assert_eq!(serde_json::to_value(LoginPoll::Pending).unwrap(), json!({"status": "pending"}));
    assert_eq!(
        serde_json::to_value(LoginPoll::Error { message: "m".into() }).unwrap(),
        json!({"status": "error", "message": "m"})
    );
    let mut complete: LoginCompleteInput = serde_json::from_value(
        json!({"sessionId": "00000000-0000-4000-8000-000000000001", "code": "  abc \n"}),
    )
    .unwrap();
    complete.validate().unwrap();
    assert_eq!(complete.code, "abc");
    assert!(!is_uuid("00000000-0000-0000-8000-000000000001"));
    assert!(is_email("a.b+c@example.co") && !is_email("a..b@example.com"));
    assert_eq!(POOL_RPC_METHODS.len(), 9);
    assert_eq!(HUB_PATH, "/api/v1/plugins/account-pool/http");
}
