use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use bb_pool::contract::{Account, AccountKind, LoginPoll, PoolConfig, PoolProvider};
use bb_pool::oauth::{
    AccountDraft, CLAUDE_CLIENT_ID, CODEX_CLIENT_ID, HttpClient, LoginDeps, Logins, OAuthError,
    OAuthSecret, TransientRefreshError, codex_draft, import_account, jwt_claims, jwt_expiry,
    parse_manual_code, pkce_challenge, refresh_oauth,
};
use bb_pool::store::now_ms;
use bytes::Bytes;
use http::{Request, Response};
use parking_lot::Mutex;
use serde_json::{Value, json};

enum Reply {
    Json(u16, Vec<(&'static str, &'static str)>, Value),
    Network,
    Hang,
}

type Sent = (String, String, Vec<(String, String)>, String);

#[derive(Default)]
struct FakeClient {
    replies: Mutex<VecDeque<Reply>>,
    requests: Mutex<Vec<Request<Bytes>>>,
}

impl FakeClient {
    fn with(replies: Vec<Reply>) -> Arc<Self> {
        Arc::new(Self { replies: Mutex::new(replies.into()), requests: Mutex::default() })
    }

    fn sent(&self) -> Vec<Sent> {
        self.requests
            .lock()
            .iter()
            .map(|request| {
                let headers = request
                    .headers()
                    .iter()
                    .map(|(name, value)| (name.to_string(), value.to_str().unwrap().to_owned()))
                    .collect();
                let body = String::from_utf8(request.body().to_vec()).unwrap();
                (request.method().to_string(), request.uri().to_string(), headers, body)
            })
            .collect()
    }
}

#[async_trait]
impl HttpClient for FakeClient {
    async fn send(&self, request: Request<Bytes>) -> Result<Response<Bytes>, String> {
        self.requests.lock().push(request);
        let reply = self.replies.lock().pop_front().expect("unexpected request");
        match reply {
            Reply::Json(status, headers, body) => {
                let mut builder = Response::builder().status(status);
                for (name, value) in headers {
                    builder = builder.header(name, value);
                }
                Ok(builder.body(Bytes::from(body.to_string())).unwrap())
            }
            Reply::Network => Err("connection refused".into()),
            Reply::Hang => {
                tokio::time::sleep(Duration::from_secs(3_600)).await;
                Err("hung".into())
            }
        }
    }
}

fn config() -> PoolConfig {
    PoolConfig {
        anthropic_upstream_base_url: "http://api.test/".into(),
        codex_upstream_base_url: "http://codex.test/backend-api/codex".into(),
        claude_token_url: "http://token.test/v1/oauth/token".into(),
        codex_auth_base_url: "http://auth.test//".into(),
        switch_threshold: 0.9,
    }
}

fn jwt(claims: Value) -> String {
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"none"}"#);
    format!("{header}.{}.sig", URL_SAFE_NO_PAD.encode(claims.to_string()))
}

fn account(draft: &AccountDraft) -> Account {
    let new = draft.new_account(None, 100);
    Account {
        id: "acct-1".into(),
        provider: new.provider,
        kind: new.kind,
        label: new.label,
        email: new.email,
        account_uuid: new.account_uuid,
        codex_account_id: new.codex_account_id,
        subscription_type: new.subscription_type,
        rate_limit_tier: new.rate_limit_tier,
        enabled: new.enabled,
        priority: new.priority,
        created_at: 1,
        last_used_at: None,
        last_used_host_id: None,
    }
}

fn logins(client: Arc<FakeClient>) -> (Logins, Arc<Mutex<Vec<AccountDraft>>>) {
    let drafts = Arc::new(Mutex::new(Vec::new()));
    let captured = drafts.clone();
    let deps = LoginDeps {
        client,
        config: Arc::new(config),
        add: Arc::new(move |draft: AccountDraft| {
            let added = account(&draft);
            captured.lock().push(draft);
            Box::pin(async move { Ok(added) })
        }),
    };
    (Logins::new(deps), drafts)
}

fn message(error: OAuthError) -> String {
    error.to_string()
}

#[test]
fn pkce_challenge_matches_rfc_7636_vector() {
    assert_eq!(
        pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
}

#[test]
fn parse_manual_code_accepts_and_rejects() {
    let ok = |pasted: &str| parse_manual_code(pasted, "st8").map(|parsed| parsed.code);
    assert_eq!(ok("  abc  ").unwrap(), "abc");
    assert_eq!(ok("abc#st8").unwrap(), "abc");
    assert_eq!(ok("abc# st8 ").unwrap(), "abc");
    assert_eq!(ok("abc#").unwrap(), "abc");
    assert_eq!(
        ok("https://console.anthropic.com/oauth/code/callback?code=xyz&state=st8").unwrap(),
        "xyz"
    );
    assert_eq!(ok("https://example.test/cb?code=xyz").unwrap(), "xyz");
    assert_eq!(ok("https://example.test/cb?other=1").unwrap(), "https://example.test/cb?other=1");
    let parsed = parse_manual_code("abc", "st8").unwrap();
    assert_eq!(parsed.state, "st8");

    let err = |pasted: &str| message(parse_manual_code(pasted, "st8").unwrap_err());
    assert_eq!(err("abc#other"), "OAuth state mismatch. Start again.");
    assert_eq!(
        err("https://example.test/cb?code=xyz&state=nope"),
        "OAuth state mismatch. Start again."
    );
    assert_eq!(err("   "), "Paste the authorization code.");
    assert_eq!(err("#st8"), "Paste the authorization code.");
    assert_eq!(err("https://example.test/cb?code=&state=st8"), "Paste the authorization code.");
}

#[test]
fn jwt_claims_and_expiry() {
    let token = jwt(json!({ "exp": 1_700_000_000.4, "email": "a@b.co" }));
    assert_eq!(jwt_expiry(&token), Some(1_700_000_000_400));
    assert_eq!(jwt_claims(Some(&token))["email"], "a@b.co");
    assert_eq!(jwt_claims(Some("not-a-jwt")), Value::Null);
    assert_eq!(jwt_claims(None), Value::Null);
    assert_eq!(jwt_expiry(&jwt(json!({ "exp": -5 }))), None);
    assert_eq!(jwt_expiry(&jwt(json!({ "exp": "soon" }))), None);

    let id = jwt(json!({
        "https://api.openai.com/auth": { "chatgpt_account_id": "acc-nested" },
        "https://api.openai.com/profile": { "email": "p@q.io" },
    }));
    let access = jwt(json!({ "exp": 2_000_000_000 }));
    let draft = codex_draft(&access, "r", Some(&id), None).unwrap();
    assert_eq!(draft.codex_account_id.as_deref(), Some("acc-nested"));
    assert_eq!(draft.email.as_deref(), Some("p@q.io"));
    assert_eq!(draft.label, "p@q.io");
    assert_eq!(draft.secret.expires_at, Some(2_000_000_000_000));
    assert_eq!(draft.secret.id_token.as_deref(), Some(id.as_str()));

    let flat = jwt(json!({ "chatgpt_account_id": "acc-flat", "email": "not an email" }));
    let draft = codex_draft(&access, "r", Some(&flat), None).unwrap();
    assert_eq!(draft.codex_account_id.as_deref(), Some("acc-flat"));
    assert_eq!((draft.email, draft.label.as_str()), (None, "Codex account"));

    let missing = codex_draft(&access, "r", None, None).unwrap_err();
    assert_eq!(message(missing), "Codex tokens do not include a ChatGPT account id.");
}

#[tokio::test]
async fn claude_login_round_trip() {
    let client = FakeClient::with(vec![
        Reply::Json(
            200,
            vec![],
            json!({ "access_token": "at", "refresh_token": "rt", "expires_in": 3600 }),
        ),
        Reply::Json(
            200,
            vec![],
            json!({
                "account": {
                    "uuid": "4f9d1c2a-6b3e-4c5d-8e7f-0a1b2c3d4e5f",
                    "email": "me@example.com",
                    "has_claude_max": true,
                    "rate_limit_tier": "default_claude_max_20x",
                },
                "organization": { "name": "Org" },
            }),
        ),
    ]);
    let (logins, drafts) = logins(client.clone());
    let started = logins.start(PoolProvider::Claude).await.unwrap();
    started.validate().unwrap();
    assert!(started.device.is_none());
    let url = url::Url::parse(&started.url).unwrap();
    assert_eq!(url.origin().ascii_serialization(), "https://claude.ai");
    let param = |key: &str| {
        url.query_pairs()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.into_owned())
            .unwrap()
    };
    assert_eq!(param("client_id"), CLAUDE_CLIENT_ID);
    assert_eq!(param("code_challenge_method"), "S256");
    assert!(started.url.contains("scope=org%3Acreate_api_key+user%3Aprofile+"));
    let state = param("state");

    let wrong = logins.complete("other-session", "abc").await.unwrap_err();
    assert_eq!(message(wrong), "Login session was not found. Start again.");

    let before = now_ms();
    let added = logins.complete(&started.session_id, &format!("the-code#{state}")).await.unwrap();
    assert_eq!(added.kind, AccountKind::OAuth);

    let sent = client.sent();
    assert_eq!(sent.len(), 2);
    let (method, uri, headers, body) = &sent[0];
    assert_eq!((method.as_str(), uri.as_str()), ("POST", "http://token.test/v1/oauth/token"));
    let json_headers = vec![
        ("accept".to_owned(), "application/json".to_owned()),
        ("content-type".to_owned(), "application/json".to_owned()),
    ];
    assert_eq!(headers, &json_headers);
    let parsed: Value = serde_json::from_str(body).unwrap();
    let verifier = parsed["code_verifier"].as_str().unwrap();
    assert_eq!(pkce_challenge(verifier), param("code_challenge"));
    let expected = format!(
        "{{\"grant_type\":\"authorization_code\",\"code\":\"the-code\",\"state\":\"{state}\",\
         \"code_verifier\":\"{verifier}\",\
         \"redirect_uri\":\"https://console.anthropic.com/oauth/code/callback\",\
         \"client_id\":\"{CLAUDE_CLIENT_ID}\"}}"
    );
    assert_eq!(body, &expected);

    let (method, uri, headers, body) = &sent[1];
    assert_eq!((method.as_str(), uri.as_str()), ("GET", "http://api.test/api/oauth/profile"));
    let profile_headers = vec![
        ("authorization".to_owned(), "Bearer at".to_owned()),
        ("anthropic-beta".to_owned(), "oauth-2025-04-20".to_owned()),
    ];
    assert_eq!((headers, body.as_str()), (&profile_headers, ""));

    let draft = drafts.lock().pop().unwrap();
    assert_eq!(draft.provider, PoolProvider::Claude);
    assert_eq!(draft.label, "me@example.com");
    assert_eq!(draft.email.as_deref(), Some("me@example.com"));
    assert_eq!(draft.account_uuid.as_deref(), Some("4f9d1c2a-6b3e-4c5d-8e7f-0a1b2c3d4e5f"));
    assert_eq!(draft.subscription_type.as_deref(), Some("max"));
    assert_eq!(draft.rate_limit_tier.as_deref(), Some("default_claude_max_20x"));
    assert_eq!(
        (draft.secret.access_token.as_str(), draft.secret.refresh_token.as_str()),
        ("at", "rt")
    );
    let expires = draft.secret.expires_at.unwrap();
    assert!(expires >= before + 3_600_000 && expires <= now_ms() + 3_600_000);

    let again = logins.complete(&started.session_id, "x").await.unwrap_err();
    assert_eq!(message(again), "Login session was not found. Start again.");
}

#[tokio::test]
async fn codex_device_flow_polls_pending_then_completes() {
    let access = jwt(
        json!({ "exp": 2_000_000_000, "https://api.openai.com/auth": { "chatgpt_account_id": "acc-9" } }),
    );
    let id = jwt(json!({ "email": "dev@example.com" }));
    let client = FakeClient::with(vec![
        Reply::Json(
            200,
            vec![],
            json!({ "device_auth_id": "dev-1", "user_code": "ABCD-1234", "interval": "0.05" }),
        ),
        Reply::Json(
            404,
            vec![],
            json!({ "error": { "code": "deviceauth_authorization_pending" } }),
        ),
        Reply::Json(200, vec![], json!({ "authorization_code": "grant", "code_verifier": "ver" })),
        Reply::Json(
            200,
            vec![],
            json!({ "access_token": access, "refresh_token": "rt", "id_token": id }),
        ),
    ]);
    let (logins, drafts) = logins(client.clone());
    let before = now_ms();
    let started = logins.start(PoolProvider::Codex).await.unwrap();
    started.validate().unwrap();
    assert_eq!(started.url, "http://auth.test/codex/device");
    let device = started.device.clone().unwrap();
    assert_eq!((device.user_code.as_str(), device.interval_ms), ("ABCD-1234", 50));
    assert!(started.expires_at >= before + 600_000 && started.expires_at <= now_ms() + 600_000);

    assert_eq!(logins.poll(&started.session_id).await, LoginPoll::Pending);
    assert_eq!(client.sent().len(), 1);
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert_eq!(logins.poll(&started.session_id).await, LoginPoll::Pending);
    assert_eq!(client.sent().len(), 2);
    tokio::time::sleep(Duration::from_millis(80)).await;
    let LoginPoll::Complete { account } = logins.poll(&started.session_id).await else {
        panic!("login did not complete");
    };
    assert_eq!(account.codex_account_id.as_deref(), Some("acc-9"));

    let sent = client.sent();
    assert_eq!(sent[0].1, "http://auth.test/api/accounts/deviceauth/usercode");
    assert_eq!(sent[0].3, format!("{{\"client_id\":\"{CODEX_CLIENT_ID}\"}}"));
    assert_eq!(sent[1].1, "http://auth.test/api/accounts/deviceauth/token");
    assert_eq!(sent[1].3, r#"{"device_auth_id":"dev-1","user_code":"ABCD-1234"}"#);
    let (method, uri, headers, body) = &sent[3];
    assert_eq!((method.as_str(), uri.as_str()), ("POST", "http://auth.test/oauth/token"));
    assert_eq!(headers[1], ("content-type".into(), "application/x-www-form-urlencoded".into()));
    assert_eq!(
        body,
        &format!(
            "grant_type=authorization_code&code=grant\
             &redirect_uri=http%3A%2F%2Fauth.test%2Fdeviceauth%2Fcallback\
             &client_id={CODEX_CLIENT_ID}&code_verifier=ver"
        )
    );
    let draft = drafts.lock().pop().unwrap();
    assert_eq!(draft.email.as_deref(), Some("dev@example.com"));
    assert_eq!(draft.secret.expires_at, Some(2_000_000_000_000));

    let gone = logins.poll(&started.session_id).await;
    assert_eq!(
        gone,
        LoginPoll::Error { message: "Login session was not found. Start again.".into() }
    );
}

#[tokio::test]
async fn codex_device_flow_slows_down_and_fails() {
    let client = FakeClient::with(vec![
        Reply::Json(
            200,
            vec![],
            json!({ "device_auth_id": "d", "user_code": "U", "interval": 0.01 }),
        ),
        Reply::Json(400, vec![], json!({ "error": { "code": "slow_down" } })),
        Reply::Json(
            200,
            vec![],
            json!({ "device_auth_id": "d", "user_code": "U", "interval": 0.01 }),
        ),
        Reply::Json(400, vec![], json!({ "error": { "code": "access_denied" } })),
        Reply::Json(200, vec![], json!({ "user_code": "U", "interval": 5 })),
    ]);
    let (logins, _) = logins(client.clone());
    let slow = logins.start(PoolProvider::Codex).await.unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(logins.poll(&slow.session_id).await, LoginPoll::Pending);
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(logins.poll(&slow.session_id).await, LoginPoll::Pending);
    assert_eq!(client.sent().len(), 2);

    let denied = logins.start(PoolProvider::Codex).await.unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    let poll = logins.poll(&denied.session_id).await;
    let declined = "Codex authorization was declined. Start again.";
    assert_eq!(poll, LoginPoll::Error { message: declined.into() });

    let invalid = logins.start(PoolProvider::Codex).await.unwrap_err();
    assert_eq!(message(invalid), "Codex device login returned an invalid response. Start again.");
}

fn oauth_secret() -> OAuthSecret {
    OAuthSecret {
        access_token: "old".into(),
        refresh_token: "old-refresh".into(),
        expires_at: Some(1),
        id_token: Some("old-id".into()),
    }
}

#[tokio::test]
async fn refresh_succeeds_for_both_providers() {
    let client = FakeClient::with(vec![Reply::Json(
        200,
        vec![],
        json!({ "access_token": "new", "expires_in": 3600 }),
    )]);
    let before = now_ms();
    let fresh = refresh_oauth(PoolProvider::Claude, &oauth_secret(), &config(), client.as_ref())
        .await
        .unwrap();
    assert_eq!((fresh.access_token.as_str(), fresh.refresh_token.as_str()), ("new", "old-refresh"));
    assert_eq!(fresh.id_token.as_deref(), Some("old-id"));
    let expires = fresh.expires_at.unwrap();
    assert!(expires >= before + 3_600_000 && expires <= now_ms() + 3_600_000);
    let (method, uri, headers, body) = &client.sent()[0];
    assert_eq!((method.as_str(), uri.as_str()), ("POST", "http://token.test/v1/oauth/token"));
    assert_eq!(headers.len(), 2);
    assert_eq!(
        body,
        &format!(
            "{{\"grant_type\":\"refresh_token\",\"refresh_token\":\"old-refresh\",\"client_id\":\"{CLAUDE_CLIENT_ID}\"}}"
        )
    );

    let access = jwt(json!({ "exp": 1_900_000_000 }));
    let client = FakeClient::with(vec![Reply::Json(
        200,
        vec![],
        json!({ "access_token": access, "refresh_token": "next", "id_token": "new-id", "expires_in": 10 }),
    )]);
    let fresh = refresh_oauth(PoolProvider::Codex, &oauth_secret(), &config(), client.as_ref())
        .await
        .unwrap();
    assert_eq!(fresh.expires_at, Some(1_900_000_000_000));
    assert_eq!((fresh.refresh_token.as_str(), fresh.id_token.as_deref()), ("next", Some("new-id")));
    assert_eq!(client.sent()[0].1, "http://auth.test/oauth/token");

    let client = FakeClient::with(vec![Reply::Json(
        200,
        vec![],
        json!({ "access_token": "a", "expires_at": 1_800_000_000 }),
    )]);
    let fresh = refresh_oauth(PoolProvider::Claude, &oauth_secret(), &config(), client.as_ref())
        .await
        .unwrap();
    assert_eq!(fresh.expires_at, Some(1_800_000_000_000));
}

async fn refresh_error(reply: Reply) -> OAuthError {
    let client = FakeClient::with(vec![reply]);
    refresh_oauth(PoolProvider::Claude, &oauth_secret(), &config(), client.as_ref())
        .await
        .unwrap_err()
}

fn transient(reason: &str, retry_after_ms: i64) -> OAuthError {
    OAuthError::Transient(TransientRefreshError { reason: reason.into(), retry_after_ms })
}

#[tokio::test]
async fn refresh_distinguishes_transient_from_permanent_failures() {
    let unavailable = refresh_error(Reply::Json(503, vec![("retry-after", "7")], json!({}))).await;
    assert_eq!(unavailable, transient("failed with HTTP 503", 7_000));
    assert_eq!(unavailable.to_string(), "OAuth refresh failed with HTTP 503.");
    let limited = refresh_error(Reply::Json(429, vec![], Value::Null)).await;
    assert_eq!(limited, transient("failed with HTTP 429", 1_000));
    let network = refresh_error(Reply::Network).await;
    assert_eq!(network, transient("failed due to a network error or timeout", 0));
    let unreadable = refresh_error(Reply::Json(200, vec![], json!({ "token": "x" }))).await;
    assert_eq!(unreadable, transient("returned an unreadable response", 0));

    let grant = refresh_error(Reply::Json(400, vec![], json!({ "error": "invalid_grant" }))).await;
    assert_eq!(grant, OAuthError::Failed("OAuth refresh failed with HTTP 400.".into()));
    let unauthorized = refresh_error(Reply::Json(401, vec![], json!({}))).await;
    assert_eq!(unauthorized.to_string(), "OAuth refresh failed with HTTP 401.");
}

#[tokio::test(start_paused = true)]
async fn refresh_times_out_after_fifteen_seconds() {
    let started = tokio::time::Instant::now();
    let hung = refresh_error(Reply::Hang).await;
    assert_eq!(hung, transient("failed due to a network error or timeout", 0));
    assert_eq!(started.elapsed(), Duration::from_secs(15));
}

#[tokio::test]
async fn import_account_reads_cli_credentials() {
    let home = tempfile::tempdir().unwrap();
    let missing = import_account(PoolProvider::Claude, home.path()).await.unwrap_err();
    assert_eq!(
        missing.to_string(),
        "Claude Code OAuth credentials were not found. Run `claude /login` on the bb server host, then retry."
    );
    let missing = import_account(PoolProvider::Codex, home.path()).await.unwrap_err();
    assert_eq!(
        missing.to_string(),
        "Codex OAuth credentials were not found. Run `codex login` on the bb server host, then retry."
    );

    std::fs::create_dir_all(home.path().join(".claude")).unwrap();
    let credentials = json!({ "claudeAiOauth": {
        "accessToken": " cat ", "refreshToken": "crt", "expiresAt": 1_750_000_000_000.6_f64,
        "subscriptionType": "max", "rateLimitTier": "tier",
    }});
    std::fs::write(home.path().join(".claude/.credentials.json"), credentials.to_string()).unwrap();
    let owner = json!({ "oauthAccount": {
        "emailAddress": "owner@example.com", "accountUuid": "4f9d1c2a-6b3e-4c5d-8e7f-0a1b2c3d4e5f",
    }});
    std::fs::write(home.path().join(".claude.json"), owner.to_string()).unwrap();
    let claude = import_account(PoolProvider::Claude, home.path()).await.unwrap();
    assert_eq!(claude.label, "owner@example.com");
    assert_eq!(claude.account_uuid.as_deref(), Some("4f9d1c2a-6b3e-4c5d-8e7f-0a1b2c3d4e5f"));
    assert_eq!(claude.subscription_type.as_deref(), Some("max"));
    assert_eq!(claude.rate_limit_tier.as_deref(), Some("tier"));
    assert_eq!(
        claude.secret,
        OAuthSecret {
            access_token: "cat".into(),
            refresh_token: "crt".into(),
            expires_at: Some(1_750_000_000_001),
            id_token: None,
        }
    );

    std::fs::create_dir_all(home.path().join(".codex")).unwrap();
    let access = jwt(json!({ "exp": 1_760_000_000, "email": "x@y.dev" }));
    let auth = json!({ "tokens": { "access_token": access, "refresh_token": "xrt", "account_id": "acc-file" } });
    std::fs::write(home.path().join(".codex/auth.json"), auth.to_string()).unwrap();
    let codex = import_account(PoolProvider::Codex, home.path()).await.unwrap();
    assert_eq!(codex.codex_account_id.as_deref(), Some("acc-file"));
    assert_eq!((codex.label.as_str(), codex.email.as_deref()), ("x@y.dev", Some("x@y.dev")));
    assert_eq!(codex.secret.expires_at, Some(1_760_000_000_000));
    assert_eq!(codex.secret.id_token, None);
    let new = codex.new_account(Some("Named".into()), 7);
    assert_eq!((new.label.as_str(), new.priority, new.enabled), ("Named", 7, true));
}
