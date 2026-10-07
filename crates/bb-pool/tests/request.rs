use bb_pool::contract::Account;
use bb_pool::contract::ModelFamily;
use bb_pool::request::*;
use bytes::Bytes;
use http::{HeaderMap, HeaderValue, Uri};
use serde_json::{Value, json};

const A: &str = "00000000-0000-4000-8000-00000000000a";
const B: &str = "00000000-0000-4000-8000-00000000000b";
const FIVE: &str = "00000000-0000-4000-8000-000000000005";

fn account(uuid: Option<&str>) -> Account {
    serde_json::from_value(json!({
        "id": "00000000-0000-4000-8000-000000000001", "provider": "claude", "kind": "oauth",
        "label": "one", "email": null, "accountUuid": uuid, "subscriptionType": null,
        "rateLimitTier": null, "enabled": true, "priority": 0, "createdAt": 1
    }))
    .unwrap()
}

fn body(value: Value) -> Bytes {
    Bytes::from(value.to_string())
}

#[test]
fn claude_json_user_id_gets_the_account_uuid() {
    let user = json!({"session_id": "s1", "account_uuid": null}).to_string();
    let sent = body(
        json!({"messages": [], "metadata": {"extra": 1, "user_id": user}, "model": "claude-opus-4"}),
    );
    let parsed = parse_claude_request(sent.clone());
    assert_eq!(parsed.family, ModelFamily::Opus);
    assert_eq!(parsed.affinity_id.as_deref(), Some("session:s1"));
    assert_eq!(parsed.parent_affinity_id, None);
    assert_eq!(parsed.for_account(&account(None)), sent);
    let out = parsed.for_account(&account(Some(FIVE)));
    let text = String::from_utf8(out.to_vec()).unwrap();
    assert!(text.starts_with(r#"{"model":"claude-opus-4","metadata":{"user_id":"#), "{text}");
    let value: Value = serde_json::from_str(&text).unwrap();
    let user: Value = serde_json::from_str(value["metadata"]["user_id"].as_str().unwrap()).unwrap();
    assert_eq!(user, json!({"session_id": "s1", "account_uuid": FIVE}));
    assert_eq!(value["metadata"]["extra"], json!(1));
}

#[test]
fn claude_json_user_id_left_alone_when_matching_or_absent() {
    let same =
        json!({"account_uuid": FIVE, "session_id": "s1", "parent_session_id": "p1"}).to_string();
    let sent = body(json!({"model": "x", "metadata": {"user_id": same}}));
    let parsed = parse_claude_request(sent.clone());
    assert_eq!(parsed.parent_affinity_id.as_deref(), Some("session:p1"));
    assert_eq!(parsed.for_account(&account(Some(FIVE))), sent);
    let missing = json!({"session_id": "s1"}).to_string();
    let sent = body(json!({"metadata": {"user_id": missing}}));
    assert_eq!(parse_claude_request(sent.clone()).for_account(&account(Some(FIVE))), sent);
    let invalid = json!({"session_id": "s1", "account_uuid": "nope"}).to_string();
    let sent = body(json!({"metadata": {"user_id": invalid}}));
    assert_eq!(parse_claude_request(sent.clone()).for_account(&account(Some(FIVE))), sent);
    let own_parent = json!({"session_id": "s1", "parent_session_id": "s1"}).to_string();
    let parsed = parse_claude_request(body(json!({"metadata": {"user_id": own_parent}})));
    assert_eq!(parsed.parent_affinity_id, None);
}

#[test]
fn claude_plain_user_id_rewrites_the_account_component() {
    let user = format!("user_abc_account_{A}_session_{B}");
    let parsed =
        parse_claude_request(body(json!({"metadata": {"user_id": user}, "model": "sonnet"})));
    assert_eq!(parsed.family, ModelFamily::Sonnet);
    assert_eq!(parsed.affinity_id, Some(format!("session:{B}")));
    let value: Value = serde_json::from_slice(&parsed.for_account(&account(Some(FIVE)))).unwrap();
    assert_eq!(value["metadata"]["user_id"], json!(format!("user_abc_account_{FIVE}_session_{B}")));
    let sent = body(json!({"metadata": {"user_id": format!("account_{A}x")}}));
    assert_eq!(parse_claude_request(sent.clone()).for_account(&account(Some(FIVE))), sent);
}

#[test]
fn claude_unparsable_bodies_pass_through() {
    for raw in [
        "not json",
        "[1]",
        r#"{"model": 5}"#,
        r#"{"metadata": []}"#,
        r#"{"metadata": {"user_id": 1}}"#,
    ] {
        let sent = Bytes::from(raw);
        let parsed = parse_claude_request(sent.clone());
        assert_eq!((parsed.family, parsed.affinity_id.clone()), (ModelFamily::Other, None));
        assert_eq!(parsed.for_account(&account(Some(FIVE))), sent);
    }
    let control = parse_claude_request(body(
        json!({"metadata": {"user_id": "{\"session_id\":\"a\\u0001\"}"}}),
    ));
    assert_eq!(control.affinity_id, None);
}

#[test]
fn codex_affinity_from_headers_and_body() {
    let mut headers = HeaderMap::new();
    headers.insert("thread-id", HeaderValue::from_static("t1"));
    headers.insert("x-codex-parent-thread-id", HeaderValue::from_static("t1"));
    headers
        .insert("x-codex-turn-metadata", HeaderValue::from_static(r#"{"parent_thread_id":"t0"}"#));
    let sent = body(json!({"prompt_cache_key": "k"}));
    let parsed = parse_codex_request(sent.clone(), &headers);
    assert_eq!(parsed.affinity_id.as_deref(), Some("session:t1"));
    assert_eq!(parsed.parent_affinity_id.as_deref(), Some("session:t0"));
    assert_eq!(parsed.for_account(&account(Some(FIVE))), sent);
    let embedded = json!({"thread_id": "t9", "forked_from_thread_id": "t8"}).to_string();
    let parsed = parse_codex_request(
        body(json!({"client_metadata": {"x-codex-turn-metadata": embedded}})),
        &HeaderMap::new(),
    );
    assert_eq!(parsed.affinity_id.as_deref(), Some("session:t9"));
    assert_eq!(parsed.parent_affinity_id.as_deref(), Some("session:t8"));
    let cached = parse_codex_request(body(json!({"prompt_cache_key": "k"})), &HeaderMap::new());
    assert_eq!((cached.affinity_id.as_deref(), cached.parent_affinity_id), (Some("cache:k"), None));
}

#[test]
fn upstream_headers_and_urls() {
    let mut inbound = HeaderMap::new();
    inbound.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
    inbound.insert("anthropic-beta", HeaderValue::from_static("a"));
    inbound.append("anthropic-beta", HeaderValue::from_static("b"));
    inbound.insert("x-custom", HeaderValue::from_static("1"));
    inbound.insert("x-bb-account-pool-token", HeaderValue::from_static("secret"));
    inbound.insert("content-type", HeaderValue::from_static("application/json"));
    let out = upstream_headers(&inbound, &["content-type"], &["anthropic-"]);
    assert_eq!(out.len(), 4);
    assert_eq!(out.get_all("anthropic-beta").iter().count(), 2);
    assert!(!out.contains_key("x-custom") && !out.contains_key("x-bb-account-pool-token"));

    let hub: Uri =
        "http://localhost/api/v1/plugins/account-pool/http/v1/messages?beta=true".parse().unwrap();
    let url = upstream_url(&hub, "https://api.anthropic.com", "").unwrap();
    assert_eq!(url.as_str(), "https://api.anthropic.com/v1/messages?beta=true");
    let codex: Uri = "/api/v1/plugins/account-pool/http/v1/responses".parse().unwrap();
    let url = upstream_url(&codex, "http://127.0.0.1:9/backend-api/codex", "v1/").unwrap();
    assert_eq!(url.as_str(), "http://127.0.0.1:9/backend-api/codex/responses");
    let bare: Uri = "/v1/models?".parse().unwrap();
    let url = upstream_url(&bare, "http://127.0.0.1:9/backend-api/codex/", "v1/").unwrap();
    assert_eq!(url.as_str(), "http://127.0.0.1:9/backend-api/codex/models");
}
