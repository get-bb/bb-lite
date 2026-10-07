use bb_pool::contract::{
    Account, AccountKind, AccountQuota, AccountStatus, ModelFamily, PoolProvider,
};
use bb_pool::limits::*;
use http::{HeaderMap, HeaderName, HeaderValue};
use serde_json::json;

const NOW: i64 = 1_800_000_000_000;
const LIMIT: &str = "anthropic-ratelimit-unified";

fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (name, value) in pairs {
        map.append(
            HeaderName::from_bytes(name.as_bytes()).unwrap(),
            HeaderValue::from_str(value).unwrap(),
        );
    }
    map
}

fn account(enabled: bool) -> Account {
    serde_json::from_value(json!({
        "id": "00000000-0000-4000-8000-000000000001", "provider": "claude", "kind": "oauth",
        "label": "one", "email": null, "subscriptionType": null, "rateLimitTier": null,
        "enabled": enabled, "priority": 0, "createdAt": 1
    }))
    .unwrap()
}

#[test]
fn claude_near_limit_switches_at_threshold() {
    let later = (NOW / 1_000 + 3_600).to_string();
    let h = headers(&[
        (&format!("{LIMIT}-5h-utilization"), "0.99"),
        (&format!("{LIMIT}-5h-reset"), &later),
    ]);
    let quota = claude_quota_from_headers(&h, &EMPTY_QUOTA, ModelFamily::Opus, NOW);
    assert_eq!(quota.windows.len(), 1);
    let window = &quota.windows[0];
    assert_eq!(
        (window.key.as_str(), window.utilization, window.reset_at),
        ("5h", Some(0.99), Some(NOW + 3_600_000))
    );
    assert_eq!(quota.observed_at, Some(NOW));
    assert!(is_exhausted(&quota, None, 0.98, NOW));
    assert!(!is_exhausted(&quota, None, 1.0, NOW));
    assert!(!is_exhausted(&quota, None, 0.98, NOW + 3_600_000));
    assert_eq!(account_status(&account(true), &quota, 0.98, NOW), AccountStatus::Exhausted);
    assert_eq!(account_status(&account(true), &quota, 1.0, NOW), AccountStatus::Ready);
    assert_eq!(account_status(&account(false), &quota, 0.98, NOW), AccountStatus::Disabled);
    assert_eq!(blocking_reset_at(&quota, None, 0.98, NOW), Some(NOW + 3_600_000));
    assert!(!is_claude_quota_rejection(&h));
}

#[test]
fn claude_rejection_and_scoped_family_windows() {
    let h = headers(&[
        (&format!("{LIMIT}-7d-status"), "rejected"),
        (&format!("{LIMIT}-7d_opus-utilization"), "0.5"),
        (&format!("{LIMIT}-overage-status"), "rejected"),
    ]);
    assert!(is_claude_quota_rejection(&h));
    let previous = AccountQuota { extra_usage: Some(true), ..EMPTY_QUOTA };
    let quota = claude_quota_from_headers(&h, &previous, ModelFamily::Opus, NOW);
    let keys: Vec<&str> = quota.windows.iter().map(|w| w.key.as_str()).collect();
    assert_eq!(keys, ["7d", "7d:opus"]);
    assert_eq!(quota.windows[0].status.as_deref(), Some("rejected"));
    assert_eq!(quota.extra_usage, Some(false));
    assert!(is_exhausted(&quota, None, 1.0, NOW));
    assert_eq!(blocking_reset_at(&quota, None, 1.0, NOW), None);
    let scoped = headers(&[(&format!("{LIMIT}-7d_opus-status"), "Rejected")]);
    assert!(is_claude_quota_rejection(&scoped));
    let quota = claude_quota_from_headers(&scoped, &EMPTY_QUOTA, ModelFamily::Sonnet, NOW);
    assert!(is_exhausted(&quota, Some(ModelFamily::Sonnet), 1.0, NOW));
    assert!(!is_exhausted(&quota, Some(ModelFamily::Opus), 1.0, NOW));
    assert!(!is_exhausted(&quota, None, 1.0, NOW));
}

#[test]
fn claude_headers_merge_with_prior_and_keep_unobserved() {
    let first = headers(&[
        (&format!("{LIMIT}-5h-utilization"), "0.2"),
        (&format!("{LIMIT}-5h-reset"), "2027-01-15T08:00:00Z"),
    ]);
    let prior = claude_quota_from_headers(&first, &EMPTY_QUOTA, ModelFamily::Other, NOW);
    assert_eq!(prior.windows[0].reset_at, parse_date("2027-01-15T08:00:00Z"));
    let second = headers(&[(&format!("{LIMIT}-5h-status"), "allowed")]);
    let merged = claude_quota_from_headers(&second, &prior, ModelFamily::Other, NOW + 5);
    assert_eq!(merged.windows[0].utilization, Some(0.2));
    assert_eq!(merged.windows[0].status.as_deref(), Some("allowed"));
    assert_eq!(merged.observed_at, Some(NOW + 5));
    let untouched =
        claude_quota_from_headers(&HeaderMap::new(), &merged, ModelFamily::Other, NOW + 9);
    assert_eq!(untouched, merged);
}

#[test]
fn codex_usage_limit_headers() {
    let h = headers(&[
        ("x-codex-primary-used-percent", "100"),
        ("x-codex-primary-reset-after-seconds", "3600"),
        ("x-codex-primary-window-minutes", "300"),
    ]);
    assert!(is_codex_quota_rejection(&h));
    let previous = AccountQuota { held_until: Some(NOW + 1), ..EMPTY_QUOTA };
    let quota = codex_quota_from_headers(&h, &previous, NOW);
    assert_eq!(quota.windows.len(), 1);
    let w = &quota.windows[0];
    assert_eq!((w.key.as_str(), w.minutes, w.utilization), ("primary", Some(300), Some(1.0)));
    assert_eq!((w.reset_at, w.status.as_deref()), (Some(NOW + 3_600_000), Some("rejected")));
    assert_eq!((quota.held_until, quota.observed_at), (None, Some(NOW)));
    assert_eq!(account_status(&account(true), &quota, 0.98, NOW), AccountStatus::Exhausted);
    assert_eq!(codex_quota_from_headers(&HeaderMap::new(), &quota, NOW + 1), quota);
    assert!(is_codex_quota_rejection(&headers(&[("x-codex-rate-limit-reached-type", "x")])));
    assert!(is_codex_quota_rejection(&headers(&[("x-codex-secondary-over-limit", "TRUE")])));
    assert!(!is_codex_quota_rejection(&headers(&[("x-codex-primary-used-percent", "99")])));
    let credits =
        headers(&[("x-codex-credits-has-credits", "0"), ("x-codex-credits-unlimited", "true")]);
    let funded = codex_quota_from_headers(&credits, &quota, NOW + 2);
    assert_eq!((funded.extra_usage, funded.windows.len()), (Some(true), 1));
    assert_eq!(account_status(&account(true), &funded, 0.98, NOW), AccountStatus::Ready);
    let zero = codex_quota_from_headers(
        &headers(&[("x-codex-primary-used-percent", "0")]),
        &EMPTY_QUOTA,
        NOW,
    );
    assert_eq!(zero.windows, vec![]);
    assert_eq!(zero.observed_at, None);
}

#[test]
fn usage_payloads() {
    let payload = json!({
        "five_hour": {"utilization": 42, "resets_at": "2027-01-15T08:00:00.000+00:00"},
        "seven_day": null,
        "limits": [
            {"kind": "weekly_scoped", "scope": {"model": {"display_name": "Claude Opus"}}, "utilization": 30},
            {"group": "weekly", "scope": {"model": {"display_name": "Opus 5"}}, "used_percentage": 100},
            {"kind": "daily", "scope": {"model": {"display_name": "Sonnet"}}, "utilization": 90}
        ],
        "extra_usage": {"is_enabled": true, "utilization": 10, "monthly_limit": 50, "used_credits": 20}
    });
    let previous = AccountQuota { windows: vec![], error: Some("x".into()), ..EMPTY_QUOTA };
    let quota = claude_quota_from_usage(&payload, &previous, NOW).unwrap();
    let keys: Vec<&str> = quota.windows.iter().map(|w| w.key.as_str()).collect();
    assert_eq!(keys, ["5h", "7d:opus"]);
    assert_eq!(quota.windows[0].utilization, Some(0.42));
    assert_eq!(quota.windows[0].status.as_deref(), Some("allowed"));
    assert_eq!(quota.windows[0].reset_at, parse_date("2027-01-15T08:00:00Z"));
    assert_eq!(quota.windows[1].status.as_deref(), Some("rejected"));
    assert_eq!((quota.extra_usage, quota.error.as_deref()), (Some(true), Some("x")));
    assert_eq!(claude_quota_from_usage(&json!({}), &previous, NOW), None);
    let off = claude_quota_from_usage(&json!({"extra_usage": null}), &previous, NOW).unwrap();
    assert_eq!(off.extra_usage, None);

    let codex = json!({
        "rate_limit": {"primary_window": {"used_percent": 55, "reset_after_seconds": 60, "limit_window_seconds": 18000},
                        "secondary_window": {"used_percent": 120, "reset_at": 1_900_000_000}},
        "credits": {"has_credits": false, "unlimited": false}
    });
    let quota = codex_quota_from_usage(&codex, &EMPTY_QUOTA, NOW).unwrap();
    let w = &quota.windows;
    assert_eq!(
        (w[0].minutes, w[0].utilization, w[0].reset_at),
        (Some(300), Some(0.55), Some(NOW + 60_000))
    );
    assert_eq!(
        (w[1].minutes, w[1].utilization, w[1].reset_at),
        (None, Some(1.0), Some(1_900_000_000_000))
    );
    assert_eq!(w[1].status.as_deref(), Some("rejected"));
    assert_eq!(quota.extra_usage, Some(false));
    assert_eq!(codex_quota_from_usage(&json!({"plan_type": "plus"}), &EMPTY_QUOTA, NOW), None);
}

#[test]
fn blocked_adds_a_window_first() {
    let h = headers(&[(&format!("{LIMIT}-5h-utilization"), "0.1")]);
    let quota = blocked(&claude_quota_from_headers(&h, &EMPTY_QUOTA, ModelFamily::Other, NOW), NOW);
    assert_eq!(quota.windows[0].key, "blocked");
    assert_eq!(quota.windows[0].reset_at, Some(NOW + 300_000));
    assert_eq!(blocking_reset_at(&quota, None, 0.98, NOW), Some(NOW + 300_000));
    assert_eq!(
        serde_json::to_value(&quota.windows[0]).unwrap(),
        json!({"key": "blocked", "minutes": null, "utilization": null, "resetAt": NOW + 300_000, "status": "rejected"})
    );
    let _ = PoolProvider::Claude;
    let _ = AccountKind::OAuth;
}

#[test]
fn scalars_dates_and_retry_after() {
    assert_eq!(model_family(Some("claude-Opus-4-1")), ModelFamily::Opus);
    assert_eq!(model_family(Some("claude-3-5-haiku")), ModelFamily::Haiku);
    assert_eq!(model_family(None), ModelFamily::Other);
    assert_eq!(epoch_ms(1_700_000_000.4), 1_700_000_000_400);
    assert_eq!(epoch_ms(1_700_000_000_000.0), 1_700_000_000_000);
    assert_eq!(js_number(" 0x10 "), Some(16.0));
    assert_eq!(js_number(""), Some(0.0));
    assert_eq!(js_number("1e3"), Some(1_000.0));
    assert_eq!(js_number("nan"), None);
    assert_eq!(parse_date("Wed, 21 Oct 2015 07:28:00 GMT"), Some(1_445_412_480_000));
    assert_eq!(parse_date("2015-10-21T09:28:00+02:00"), Some(1_445_412_480_000));
    assert_eq!(parse_date("2015-10-21"), Some(1_445_385_600_000));
    assert_eq!(parse_date("soon"), None);
    assert_eq!(retry_after_ms(None, NOW), 1_000);
    assert_eq!(retry_after_ms(Some("2.5"), NOW), 2_500);
    assert_eq!(retry_after_ms(Some("-3"), NOW), 0);
    assert_eq!(retry_after_ms(Some(""), NOW), 0);
    assert_eq!(retry_after_ms(Some("later"), NOW), 1_000);
    assert_eq!(retry_after_ms(Some("Wed, 21 Oct 2015 07:28:10 GMT"), 1_445_412_480_000), 10_000);
    let payload = json!({"a": {"b": [1]}});
    assert_eq!(dig(&payload, &["a", "b"]), Some(&json!([1])));
    assert_eq!(dig(&payload, &["a", "b", "0"]), None);
}
