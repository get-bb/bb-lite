use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::routing::get;
use bb_server::http::trust::{
    Principal, RunnerMachine, SharedTrust, TrustLookups, TrustRequest, authorize, request_header,
    require_owner, trust_guard,
};
use http::{HeaderMap, HeaderName, HeaderValue, Request, StatusCode};
use tower::ServiceExt;

struct Lookups {
    public_url: Option<String>,
}

impl TrustLookups for Lookups {
    fn allowed_hosts(&self) -> Vec<String> {
        vec!["bee.tail0.ts.net".to_owned()]
    }

    fn public_url(&self) -> Option<String> {
        self.public_url.clone()
    }

    fn runner_machine(&self, token: &str) -> Option<RunnerMachine> {
        match token {
            "bbr_enrolled" => Some(RunnerMachine { connect_machine_id: None }),
            "bbr_linked" => Some(RunnerMachine { connect_machine_id: Some("cm_1".to_owned()) }),
            _ => None,
        }
    }
}

fn lookups() -> Lookups {
    Lookups { public_url: Some("https://bee.example.test".to_owned()) }
}

const LOOPBACK: &[(&str, &str)] = &[("host", "127.0.0.1:48886")];
const TUNNEL: &[(&str, &str)] = &[("host", "127.0.0.1:48886"), ("x-bb-via-tunnel", "1")];
const SESSION: &[(&str, &str)] =
    &[("host", "127.0.0.1:48886"), ("x-bb-via-tunnel", "1"), ("x-bb-gate-auth", "session")];
const MACHINE: &[(&str, &str)] =
    &[("host", "127.0.0.1:48886"), ("x-bb-via-tunnel", "1"), ("x-bb-gate-auth", "machine")];
const EVIL: (&str, &str) = ("origin", "https://evil.example");
const REMOTE: &str = "100.64.0.7";
const ENROLLED: (&str, &str) = ("authorization", "Bearer bbr_enrolled");
const REVOKED: (&str, &str) = ("authorization", "Bearer bbr_revoked");
const TAILNET: (&str, &str) = ("host", "bee.tail0.ts.net:48886");

fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (name, value) in pairs {
        let name = HeaderName::from_bytes(name.as_bytes()).unwrap();
        map.append(name, HeaderValue::from_str(value).unwrap());
    }
    map
}

fn with(base: &[(&str, &str)], extra: &[(&str, &str)]) -> HeaderMap {
    let mut pairs = base.to_vec();
    pairs.extend_from_slice(extra);
    headers(&pairs)
}

fn verdict_with(
    lookups: &dyn TrustLookups,
    headers: &HeaderMap,
    route: &str,
    peer: Option<&str>,
) -> Result<String, (u16, String, String)> {
    let (method, path) = route.split_once(' ').unwrap();
    let peer: Option<IpAddr> = peer.map(|peer| peer.parse().unwrap());
    let request = TrustRequest { method, path, headers, peer };
    authorize(&request, lookups)
        .map(|principal| principal.kind().to_owned())
        .map_err(|error| (error.status, error.body.code, error.body.message))
}

fn verdict(headers: &HeaderMap, route: &str, peer: &str) -> Result<String, u16> {
    verdict_with(&lookups(), headers, route, Some(peer)).map_err(|(status, ..)| status)
}

const THREADS: &str = "GET /api/v1/threads";
const LOCAL: &str = "127.0.0.1";

#[test]
fn trust_guard_table_from_the_typescript_suite() {
    let owner = Ok("owner".to_owned());
    let runner = Ok("runner".to_owned());
    let anonymous = Ok("anonymous".to_owned());
    let cases: Vec<(Result<String, u16>, HeaderMap, &str, &str)> = vec![
        (owner.clone(), headers(LOOPBACK), THREADS, LOCAL),
        (owner.clone(), with(LOOPBACK, &[("origin", "http://127.0.0.1:48886")]), THREADS, LOCAL),
        (owner.clone(), with(LOOPBACK, &[("origin", "https://bee.example.test")]), THREADS, LOCAL),
        (Err(403), with(LOOPBACK, &[EVIL]), THREADS, LOCAL),
        (Err(403), with(LOOPBACK, &[("origin", "http://127.0.0.1:3000")]), THREADS, LOCAL),
        (Err(403), headers(&[("host", "evil.example:48886")]), THREADS, LOCAL),
        (
            owner.clone(),
            headers(&[TAILNET, ("origin", "https://bee.tail0.ts.net:48886")]),
            THREADS,
            LOCAL,
        ),
        (Err(403), headers(&[TAILNET, EVIL]), THREADS, LOCAL),
        (Err(404), headers(&[TAILNET]), THREADS, REMOTE),
        (owner.clone(), headers(SESSION), THREADS, LOCAL),
        (Err(403), with(SESSION, &[EVIL]), THREADS, LOCAL),
        (Err(404), headers(TUNNEL), THREADS, LOCAL),
        (Err(404), headers(SESSION), THREADS, REMOTE),
        (runner.clone(), headers(MACHINE), "POST /api/v1/threads/thr_1/send", LOCAL),
        (Err(403), headers(MACHINE), "POST /api/v1/hosts", LOCAL),
        (Err(403), headers(MACHINE), "PUT /api/v1/settings/general", LOCAL),
        (anonymous.clone(), HeaderMap::new(), "POST /internal/runner/join", REMOTE),
        (runner.clone(), headers(&[ENROLLED]), "POST /api/v1/threads/thr_1/send", REMOTE),
        (Err(403), headers(&[ENROLLED]), "DELETE /api/v1/hosts/host_1", LOCAL),
        (Err(404), headers(&[REVOKED]), THREADS, LOCAL),
        (anonymous.clone(), headers(&[REVOKED]), "GET /internal/runner/ws", LOCAL),
        (runner.clone(), with(MACHINE, &[REVOKED]), THREADS, LOCAL),
    ];
    for (index, (expected, headers, route, peer)) in cases.into_iter().enumerate() {
        assert_eq!(verdict(&headers, route, peer), expected, "case {index}: {headers:?} {route}");
    }
}

#[test]
fn owner_branches() {
    let local = Some(LOCAL);
    let checks = |headers: &HeaderMap, peer: Option<&str>| {
        verdict_with(&lookups(), headers, "POST /api/v1/anything", peer)
    };
    assert_eq!(checks(&HeaderMap::new(), local), Ok("owner".to_owned()));
    for peer in ["127.8.9.10", "::1", "::ffff:127.0.0.1"] {
        assert_eq!(checks(&headers(LOOPBACK), Some(peer)), Ok("owner".to_owned()), "{peer}");
    }
    for peer in ["::ffff:10.0.0.1", "10.0.0.1", "fe80::1"] {
        assert_eq!(checks(&headers(LOOPBACK), Some(peer)).unwrap_err().0, 404, "{peer}");
    }
    assert_eq!(checks(&headers(LOOPBACK), None).unwrap_err().0, 404);
    for host in ["localhost:1", "[::1]:48886", "LOCALHOST", "127.0.0.1", "bee.tail0.ts.net"] {
        assert_eq!(checks(&headers(&[("host", host)]), local), Ok("owner".to_owned()), "{host}");
    }
    let refused = checks(&headers(&[("host", "evil.example:48886")]), local).unwrap_err();
    assert_eq!(
        refused,
        (
            403,
            "forbidden_host".to_owned(),
            "host \"evil.example:48886\" is not an address of this bb server".to_owned()
        )
    );
    assert_eq!(checks(&headers(&[("host", "bad host:1")]), local).unwrap_err().1, "forbidden_host");
    let refused = checks(&with(LOOPBACK, &[EVIL]), local).unwrap_err();
    assert_eq!(
        refused,
        (
            403,
            "forbidden_origin".to_owned(),
            "origin \"https://evil.example\" is not this bb server".to_owned()
        )
    );
    let https = with(LOOPBACK, &[("origin", "https://127.0.0.1:48886")]);
    assert_eq!(checks(&https, local), Ok("owner".to_owned()));
    let without_public = Lookups { public_url: None };
    let public = with(LOOPBACK, &[("origin", "https://bee.example.test")]);
    let refused = verdict_with(&without_public, &public, THREADS, local).unwrap_err();
    assert_eq!(refused.1, "forbidden_origin");
    let with_path = Lookups { public_url: Some("https://bee.example.test/app/".to_owned()) };
    assert_eq!(verdict_with(&with_path, &public, THREADS, local), Ok("owner".to_owned()));
    let broken = Lookups { public_url: Some("not a url".to_owned()) };
    assert_eq!(verdict_with(&broken, &public, THREADS, local).unwrap_err().0, 500);
    let no_host = headers(&[("origin", "http://undefined")]);
    assert_eq!(checks(&no_host, local), Ok("owner".to_owned()));
    let doubled = with(LOOPBACK, &[("origin", "http://127.0.0.1:48886"), EVIL]);
    assert_eq!(checks(&doubled, local).unwrap_err().1, "forbidden_origin");
}

#[test]
fn tunnel_branches() {
    let principal = |headers: &HeaderMap, route: &str| {
        verdict_with(&lookups(), headers, route, Some(LOCAL)).map_err(|(status, ..)| status)
    };
    let doubled = with(LOOPBACK, &[("x-bb-via-tunnel", "1"), ("x-bb-via-tunnel", "1")]);
    assert_eq!(principal(&doubled, THREADS), Ok("owner".to_owned()));
    let other = with(TUNNEL, &[("x-bb-gate-auth", "other")]);
    assert_eq!(principal(&other, THREADS), Err(404));
    assert_eq!(principal(&other, "GET /internal/runner/ws"), Err(404));
    assert_eq!(principal(&headers(MACHINE), "GET /internal/runner/ws"), Ok("runner".to_owned()));
    assert_eq!(principal(&headers(MACHINE), "GET /threads"), Err(404));
    assert_eq!(principal(&headers(MACHINE), "GET /api/v1/hosts"), Ok("runner".to_owned()));
    assert_eq!(principal(&headers(MACHINE), "HEAD /api/v1/settings"), Ok("runner".to_owned()));
    assert_eq!(principal(&headers(MACHINE), "OPTIONS /api/v1/system"), Ok("runner".to_owned()));
    for route in [
        "POST /api/v1/system",
        "PATCH /api/v1/hosts/h1",
        "DELETE /api/v1/settings",
        "POST /api/v1/projects/p1/machine-environment",
        "POST /internal/runner/machine-environment",
    ] {
        assert_eq!(principal(&headers(MACHINE), route), Err(403), "{route}");
    }
    let refused = verdict_with(&lookups(), &headers(MACHINE), "POST /api/v1/hosts", Some(LOCAL));
    assert_eq!(refused.unwrap_err().2, "Machine credentials cannot manage machines or settings");
    for route in ["POST /api/v1/hostsx", "POST /api/v1/systems/x", "POST /api/v1/x/settings"] {
        assert_eq!(principal(&headers(MACHINE), route), Ok("runner".to_owned()), "{route}");
    }
    let tagged = with(MACHINE, &[("x-bb-gate-machine-id", "cm_9")]);
    let request = TrustRequest { method: "GET", path: "/api/v1/x", headers: &tagged, peer: None };
    assert_eq!(authorize(&request, &lookups()).unwrap_err().status, 404);
    let peer = Some(LOCAL.parse().unwrap());
    let request = TrustRequest { method: "GET", path: "/api/v1/x", headers: &tagged, peer };
    assert_eq!(
        authorize(&request, &lookups()),
        Ok(Principal::Runner { connect_machine_id: Some("cm_9".to_owned()) })
    );
}

#[test]
fn bearer_branches() {
    let principal = |authorization: &str, route: &str, peer: &str| {
        verdict(&headers(&[("authorization", authorization)]), route, peer)
    };
    let linked = headers(&[("authorization", "Bearer bbr_linked")]);
    let peer = Some(REMOTE.parse().unwrap());
    let request = TrustRequest { method: "GET", path: "/api/v1/x", headers: &linked, peer };
    assert_eq!(
        authorize(&request, &lookups()),
        Ok(Principal::Runner { connect_machine_id: Some("cm_1".to_owned()) })
    );
    assert_eq!(principal("Bearer bbr_enrolled", "GET /", REMOTE), Err(404));
    assert_eq!(
        principal("Bearer bbr_revoked", "GET /internal/runner/ws", REMOTE).unwrap(),
        "anonymous"
    );
    for malformed in
        ["Bearer bbr_", "bearer bbr_enrolled", "Bearer bbr_enrolled x", "Bearer  bbr_enrolled"]
    {
        assert_eq!(principal(malformed, THREADS, LOCAL).unwrap(), "owner", "{malformed}");
        assert_eq!(principal(malformed, THREADS, REMOTE), Err(404), "{malformed}");
    }
    let tunneled = with(TUNNEL, &[ENROLLED]);
    assert_eq!(verdict(&tunneled, THREADS, LOCAL), Err(404));
    let first = headers(&[ENROLLED, REVOKED]);
    assert_eq!(request_header(&first, "authorization").as_deref(), Some("Bearer bbr_enrolled"));
    assert_eq!(verdict(&first, THREADS, REMOTE).unwrap(), "runner");
}

#[test]
fn require_owner_refuses_everyone_else() {
    assert!(require_owner(&Principal::Owner, "nope").is_ok());
    for principal in [Principal::Anonymous, Principal::Runner { connect_machine_id: None }] {
        let error = require_owner(&principal, "Owners only").unwrap_err();
        assert_eq!((error.status, error.body.code.as_str()), (403, "forbidden"));
        assert_eq!(error.body.message, "Owners only");
    }
}

#[tokio::test]
async fn middleware_stores_the_principal_for_handlers() {
    let trust: SharedTrust = Arc::new(lookups());
    let app = Router::new()
        .route("/api/v1/whoami", get(|principal: Principal| async move { principal.kind() }))
        .layer(axum::middleware::from_fn_with_state(trust, trust_guard));
    let call = |peer: Option<&str>, auth: Option<&str>| {
        let mut request = Request::get("/api/v1/whoami").header("host", "127.0.0.1:48886");
        if let Some(auth) = auth {
            request = request.header("authorization", auth);
        }
        let mut request = request.body(Body::empty()).unwrap();
        if let Some(peer) = peer {
            let addr: SocketAddr = format!("{peer}:5000").parse().unwrap();
            request.extensions_mut().insert(ConnectInfo(addr));
        }
        app.clone().oneshot(request)
    };
    let text = |response: axum::response::Response| async move {
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8(body.to_vec()).unwrap())
    };
    let owner = text(call(Some(LOCAL), None).await.unwrap()).await;
    assert_eq!(owner, (StatusCode::OK, "owner".to_owned()));
    let runner = text(call(Some(REMOTE), Some("Bearer bbr_enrolled")).await.unwrap()).await;
    assert_eq!(runner, (StatusCode::OK, "runner".to_owned()));
    let (status, body) = text(call(None, None).await.unwrap()).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, r#"{"code":"not_found","message":"Not found"}"#);

    let bare =
        Router::new().route("/", get(|principal: Principal| async move { principal.kind() }));
    let request = Request::get("/").body(Body::empty()).unwrap();
    let (status, _) = text(bare.oneshot(request).await.unwrap()).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
}
