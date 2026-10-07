//! Who a request comes from (owner, runner or anonymous) and whether it may proceed.

#![allow(clippy::result_large_err)]

use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, LazyLock};

use axum::extract::{ConnectInfo, FromRequestParts, Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use http::request::Parts;
use regex::Regex;
use url::Url;

use crate::error::{ApiError, forbidden, not_found};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Principal {
    Owner,
    Runner { connect_machine_id: Option<String> },
    Anonymous,
}

impl Principal {
    pub fn kind(&self) -> &'static str {
        match self {
            Principal::Owner => "owner",
            Principal::Runner { .. } => "runner",
            Principal::Anonymous => "anonymous",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunnerMachine {
    pub connect_machine_id: Option<String>,
}

pub trait TrustLookups: Send + Sync {
    /// Host names besides loopback that address this server.
    fn allowed_hosts(&self) -> Vec<String>;
    fn public_url(&self) -> Option<String>;
    /// The enrolled machine a `bbr_` runner token belongs to.
    fn runner_machine(&self, token: &str) -> Option<RunnerMachine>;
}

pub type SharedTrust = Arc<dyn TrustLookups>;

pub struct TrustRequest<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub headers: &'a HeaderMap,
    pub peer: Option<IpAddr>,
}

const LOOPBACK_HOSTNAMES: [&str; 3] = ["127.0.0.1", "localhost", "[::1]"];
const RUNNER_PREFIX: &str = "/internal/runner/";
const API_PREFIX: &str = "/api/v1/";
const READ_METHODS: [&str; 3] = ["GET", "HEAD", "OPTIONS"];
const SINGLE_VALUED: [&str; 18] = [
    "age",
    "authorization",
    "content-length",
    "content-type",
    "etag",
    "expires",
    "from",
    "host",
    "if-modified-since",
    "if-unmodified-since",
    "last-modified",
    "location",
    "max-forwards",
    "proxy-authorization",
    "referer",
    "retry-after",
    "server",
    "user-agent",
];

static RUNNER_FORBIDDEN_WRITES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^/api/v1/(?:hosts|settings|system)(?:/|$)|/machine-environment$")
        .expect("valid pattern")
});

/// A header as Node presents it: the first value of a single-valued header,
/// every value joined with ", " otherwise.
pub fn request_header(headers: &HeaderMap, name: &str) -> Option<String> {
    let mut values = headers.get_all(name).iter().map(|value| {
        value
            .to_str()
            .map(str::to_owned)
            .unwrap_or_else(|_| value.as_bytes().iter().map(|&b| b as char).collect())
    });
    if SINGLE_VALUED.contains(&name) {
        return values.next();
    }
    let all: Vec<String> = values.collect();
    (!all.is_empty()).then(|| all.join(", "))
}

fn is_js_whitespace(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

fn runner_bearer(authorization: &str) -> Option<&str> {
    let token = authorization.strip_prefix("Bearer ")?;
    let rest = token.strip_prefix("bbr_")?;
    (!rest.is_empty() && !token.chars().any(is_js_whitespace)).then_some(token)
}

fn is_loopback_address(address: Option<IpAddr>) -> bool {
    match address {
        Some(IpAddr::V4(ip)) => ip.octets()[0] == 127,
        Some(IpAddr::V6(ip)) => match ip.to_ipv4_mapped() {
            Some(ipv4) => ipv4.octets()[0] == 127,
            None => ip.is_loopback(),
        },
        None => false,
    }
}

fn is_own_authority(authority: &str, allowed: &[String]) -> bool {
    let Ok(url) = Url::parse(&format!("http://{authority}")) else {
        return false;
    };
    let hostname = url.host_str().unwrap_or("");
    LOOPBACK_HOSTNAMES.contains(&hostname) || allowed.iter().any(|host| host == hostname)
}

fn identify(request: &TrustRequest<'_>, lookups: &dyn TrustLookups) -> Principal {
    let direct = request_header(request.headers, "x-bb-via-tunnel").as_deref() != Some("1");
    let authorization = request_header(request.headers, "authorization").unwrap_or_default();
    if direct && let Some(token) = runner_bearer(&authorization) {
        return match lookups.runner_machine(token) {
            None => Principal::Anonymous,
            Some(machine) => Principal::Runner { connect_machine_id: machine.connect_machine_id },
        };
    }
    if !is_loopback_address(request.peer) {
        return Principal::Anonymous;
    }
    if direct {
        return Principal::Owner;
    }
    match request_header(request.headers, "x-bb-gate-auth").as_deref() {
        Some("session") => Principal::Owner,
        Some("machine") => Principal::Runner {
            connect_machine_id: request_header(request.headers, "x-bb-gate-machine-id"),
        },
        _ => Principal::Anonymous,
    }
}

fn assert_own_browser_request(
    request: &TrustRequest<'_>,
    lookups: &dyn TrustLookups,
) -> Result<(), ApiError> {
    let host = request_header(request.headers, "host");
    if let Some(host) = &host
        && !is_own_authority(host, &lookups.allowed_hosts())
    {
        let message = format!("host \"{host}\" is not an address of this bb server");
        return Err(ApiError::new(403, "forbidden_host", message));
    }
    let Some(origin) = request_header(request.headers, "origin") else {
        return Ok(());
    };
    let host = host.as_deref().unwrap_or("undefined");
    let mut own = vec![format!("http://{host}"), format!("https://{host}")];
    if let Some(stored) = lookups.public_url() {
        let url = Url::parse(&stored).map_err(ApiError::internal)?;
        own.push(url.origin().ascii_serialization());
    }
    if !own.contains(&origin) {
        let message = format!("origin \"{origin}\" is not this bb server");
        return Err(ApiError::new(403, "forbidden_origin", message));
    }
    Ok(())
}

pub fn authorize(
    request: &TrustRequest<'_>,
    lookups: &dyn TrustLookups,
) -> Result<Principal, ApiError> {
    let principal = identify(request, lookups);
    let path = request.path;
    match principal {
        Principal::Owner => assert_own_browser_request(request, lookups)?,
        Principal::Anonymous => {
            let direct = request_header(request.headers, "x-bb-via-tunnel").as_deref() != Some("1");
            if !direct || !path.starts_with(RUNNER_PREFIX) {
                return Err(not_found());
            }
        }
        Principal::Runner { .. } => {
            if !path.starts_with(RUNNER_PREFIX) && !path.starts_with(API_PREFIX) {
                return Err(not_found());
            }
            if !READ_METHODS.contains(&request.method) && RUNNER_FORBIDDEN_WRITES.is_match(path) {
                return Err(forbidden("Machine credentials cannot manage machines or settings"));
            }
        }
    }
    Ok(principal)
}

pub fn require_owner(principal: &Principal, refusal: &str) -> Result<(), ApiError> {
    if *principal == Principal::Owner { Ok(()) } else { Err(forbidden(refusal)) }
}

/// Middleware for `axum::middleware::from_fn_with_state(trust, trust_guard)`: authorizes the
/// request by its `ConnectInfo<SocketAddr>` peer (none counts as remote) and stores the
/// `Principal` in the request extensions.
pub async fn trust_guard(
    State(lookups): State<SharedTrust>,
    mut request: Request,
    next: Next,
) -> Response {
    let peer = request.extensions().get::<ConnectInfo<SocketAddr>>().map(|info| info.0.ip());
    let method = request.method().as_str().to_owned();
    let verdict = authorize(
        &TrustRequest {
            method: &method,
            path: request.uri().path(),
            headers: request.headers(),
            peer,
        },
        lookups.as_ref(),
    );
    match verdict {
        Ok(principal) => {
            request.extensions_mut().insert(principal);
            next.run(request).await
        }
        Err(error) => error.into_response(),
    }
}

impl<S: Send + Sync> FromRequestParts<S> for Principal {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        parts
            .extensions
            .get::<Principal>()
            .cloned()
            .ok_or_else(|| ApiError::internal("Request has no principal"))
    }
}
