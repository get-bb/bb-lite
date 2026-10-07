use std::convert::Infallible;
use std::sync::Arc;

use bytes::Bytes;
use futures::TryStreamExt;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::header::{AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE, HOST, HeaderName, HeaderValue};
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{Map, Value, json};
use tokio::net::TcpListener;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use url::Url;

type ProxyBody = BoxBody<Bytes, Box<dyn std::error::Error + Send + Sync>>;

pub struct CliProxyOptions {
    pub server_url: String,
    pub headers: Map<String, Value>,
    pub runner_token: String,
}

pub struct CliProxy {
    pub url: String,
    stop: CancellationToken,
    done: tokio::sync::watch::Receiver<bool>,
}

impl CliProxy {
    pub async fn close(&self) {
        self.stop.cancel();
        let mut done = self.done.clone();
        let _ = done.wait_for(|done| *done).await;
    }
}

const API_PREFIX: &str = "/api/v1/";

fn is_hop_by_hop(name: &str) -> bool {
    matches!(
        name,
        "host" | "connection" | "keep-alive" | "te" | "trailer" | "transfer-encoding" | "upgrade"
    ) || name.strip_prefix("proxy-").is_some_and(|rest| !rest.is_empty())
}

fn refuse(status: StatusCode) -> Response<ProxyBody> {
    let (code, message) = match status.as_u16() {
        403 => ("forbidden", "This proxy only serves the bb CLI on this machine"),
        404 => ("not_found", "Not found"),
        _ => ("server_unreachable", "The bb server is unreachable"),
    };
    let body = Full::new(Bytes::from(json!({"code": code, "message": message}).to_string()));
    let mut response = Response::new(body.map_err(|never: Infallible| match never {}).boxed());
    *response.status_mut() = status;
    response.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    response
}

struct State {
    upstream: Url,
    headers: Map<String, Value>,
    runner_token: String,
    own_authorities: Vec<String>,
    client: reqwest::Client,
}

async fn handle(state: Arc<State>, incoming: Request<Incoming>) -> Response<ProxyBody> {
    let headers = incoming.headers();
    let from_browser = headers.contains_key("origin") || headers.contains_key("sec-fetch-site");
    let host = headers.get(HOST).and_then(|host| host.to_str().ok()).unwrap_or("");
    if from_browser || !state.own_authorities.iter().any(|own| own == host) {
        return refuse(StatusCode::FORBIDDEN);
    }
    let Ok(target) = state.upstream.join(&incoming.uri().to_string()) else {
        return refuse(StatusCode::NOT_FOUND);
    };
    if target.origin() != state.upstream.origin() || !target.path().starts_with(API_PREFIX) {
        return refuse(StatusCode::NOT_FOUND);
    }
    let mut forwarded = reqwest::header::HeaderMap::new();
    for (name, value) in &state.headers {
        let (Ok(name), Some(Ok(value))) =
            (HeaderName::try_from(name.as_str()), value.as_str().map(HeaderValue::from_str))
        else {
            continue;
        };
        forwarded.insert(name, value);
    }
    for (name, value) in headers {
        let own = state.headers.contains_key(name.as_str());
        if !own && !is_hop_by_hop(name.as_str()) && name != CONTENT_LENGTH {
            forwarded.append(name.clone(), value.clone());
        }
    }
    if let Ok(value) = HeaderValue::from_str(&format!("Bearer {}", state.runner_token)) {
        forwarded.insert(AUTHORIZATION, value);
    }
    let method = incoming.method().clone();
    let Ok(body) = incoming.into_body().collect().await.map(|body| body.to_bytes()) else {
        return refuse(StatusCode::BAD_GATEWAY);
    };
    let sent = state.client.request(method, target).headers(forwarded).body(body).send().await;
    let Ok(reply) = sent else { return refuse(StatusCode::BAD_GATEWAY) };
    let mut response = Response::builder().status(reply.status());
    for (name, value) in reply.headers() {
        if !is_hop_by_hop(name.as_str()) {
            response = response.header(name, value);
        }
    }
    let stream = reply.bytes_stream().map_ok(Frame::data).map_err(|error| error.into());
    response
        .body(BodyExt::boxed(StreamBody::new(stream)))
        .unwrap_or_else(|_| refuse(StatusCode::BAD_GATEWAY))
}

pub async fn start_cli_proxy(options: CliProxyOptions) -> anyhow::Result<CliProxy> {
    let upstream = Url::parse(&options.server_url)?;
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build()?;
    let state = Arc::new(State {
        upstream,
        headers: options.headers,
        runner_token: options.runner_token,
        own_authorities: vec![format!("127.0.0.1:{port}"), format!("localhost:{port}")],
        client,
    });
    let stop = CancellationToken::new();
    let (done_tx, done) = tokio::sync::watch::channel(false);
    let stopping = stop.clone();
    tokio::spawn(async move {
        let mut connections = JoinSet::new();
        loop {
            let accepted = tokio::select! {
                _ = stopping.cancelled() => break,
                accepted = listener.accept() => accepted,
            };
            let Ok((stream, _)) = accepted else { continue };
            let state = state.clone();
            let service = hyper::service::service_fn(move |request| {
                let state = state.clone();
                async move { Ok::<_, Infallible>(handle(state, request).await) }
            });
            connections.spawn(async move {
                let connection = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service);
                let _ = connection.await;
            });
            while connections.try_join_next().is_some() {}
        }
        connections.shutdown().await;
        let _ = done_tx.send(true);
    });
    Ok(CliProxy { url: format!("http://127.0.0.1:{port}"), stop, done })
}
