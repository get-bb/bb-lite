use std::convert::Infallible;
use std::sync::Arc;

use bb_remote::{CliProxyOptions, start_cli_proxy};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{Request, Response, body::Incoming};
use hyper_util::rt::TokioIo;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};

type Seen = Arc<Mutex<Vec<(String, hyper::HeaderMap)>>>;

async fn upstream(seen: Seen) -> u16 {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let seen = seen.clone();
            let service = hyper::service::service_fn(move |request: Request<Incoming>| {
                let seen = seen.clone();
                async move {
                    seen.lock().push((request.uri().to_string(), request.headers().clone()));
                    let body = request.into_body().collect().await.unwrap().to_bytes();
                    let response = Response::builder()
                        .status(201)
                        .header("content-type", "text/plain")
                        .body(Full::<Bytes>::new(body))
                        .unwrap();
                    Ok::<_, Infallible>(response)
                }
            });
            tokio::spawn(
                hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service),
            );
        }
    });
    port
}

#[tokio::test]
async fn proxies_the_agents_bb_cli_with_the_machines_credentials() {
    let seen: Seen = Arc::default();
    let port = upstream(seen.clone()).await;
    let headers: Map<String, Value> =
        Map::from_iter([("x-bb-connect-machine".to_owned(), json!("bbcm_stored"))]);
    let proxy = start_cli_proxy(CliProxyOptions {
        server_url: format!("http://127.0.0.1:{port}"),
        headers,
        runner_token: "bbr_stored".into(),
    })
    .await
    .unwrap();
    let client = reqwest::Client::new();
    let call = |path: &str, header: Option<(&'static str, &'static str)>| {
        let mut request = client.post(format!("{}{path}", proxy.url)).body("ping");
        if let Some((name, value)) = header {
            request = request.header(name, value);
        }
        request.send()
    };
    let own = Some(("authorization", "Bearer agent-supplied"));
    let sent = call("/api/v1/threads/thr_1/send?wait=1", own).await.unwrap();
    assert_eq!(sent.status(), 201);
    assert_eq!(sent.text().await.unwrap(), "ping");
    {
        let seen = seen.lock();
        assert_eq!(seen.len(), 1);
        let (url, headers) = &seen[0];
        assert_eq!(url, "/api/v1/threads/thr_1/send?wait=1");
        assert_eq!(headers["x-bb-connect-machine"], "bbcm_stored");
        assert_eq!(headers["authorization"], "Bearer bbr_stored");
        assert_eq!(headers["host"], format!("127.0.0.1:{port}").as_str());
    }
    let mut statuses = Vec::new();
    for (path, header) in [
        ("/api/v1/threads", Some(("origin", "https://evil.example"))),
        ("/api/v1/threads", Some(("sec-fetch-site", "cross-site"))),
        ("/internal/runner/join", None),
    ] {
        statuses.push(call(path, header).await.unwrap().status().as_u16());
    }
    assert_eq!(statuses, [403, 403, 404]);
    assert_eq!(seen.lock().len(), 1);
    proxy.close().await;
}
