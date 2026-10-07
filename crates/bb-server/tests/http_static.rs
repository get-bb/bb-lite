use std::io::Read;
use std::path::Path;

use axum::Router;
use axum::body::Body;
use axum::response::Response;
use bb_server::http::static_app::static_app;
use http::{Method, Request, StatusCode};
use tower::ServiceExt;

fn header(response: &Response, name: &str) -> Option<String> {
    response.headers().get(name).map(|v| v.to_str().unwrap().to_owned())
}

fn decode(coding: Option<&str>, body: &[u8]) -> String {
    let mut text = String::new();
    match coding {
        Some("br") => {
            brotli::Decompressor::new(body, 4096).read_to_string(&mut text).unwrap();
        }
        Some("gzip") => {
            flate2::read::GzDecoder::new(body).read_to_string(&mut text).unwrap();
        }
        _ => text = String::from_utf8(body.to_vec()).unwrap(),
    }
    text
}

async fn get(app: &Router, method: Method, path: &str, pairs: &[(&str, &str)]) -> Response {
    let mut request = Request::builder().method(method).uri(path);
    for (name, value) in pairs {
        request = request.header(*name, *value);
    }
    app.clone().oneshot(request.body(Body::empty()).unwrap()).await.unwrap()
}

async fn body(response: Response) -> Vec<u8> {
    axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap().to_vec()
}

fn app(dir: &Path) -> Router {
    Router::new().fallback_service(static_app(dir))
}

#[tokio::test]
async fn serves_the_app_with_an_spa_fallback_that_spares_assets() {
    let outside = tempfile::tempdir().unwrap();
    let app_dir = outside.path().join("app");
    std::fs::create_dir_all(app_dir.join("assets")).unwrap();
    std::fs::write(outside.path().join("secret.txt"), "secret").unwrap();
    std::fs::write(app_dir.join("index.html"), "<html>bb</html>").unwrap();
    let script = "export {};\n".repeat(200);
    std::fs::write(app_dir.join("assets").join("app-abc.js"), &script).unwrap();
    std::fs::write(app_dir.join("assets").join("logo.png"), &script).unwrap();
    std::fs::write(app_dir.join("small.css"), "a{}").unwrap();
    let app = app(&app_dir.join("..").join("app"));

    let route = get(&app, Method::GET, "/threads/thr_1", &[]).await;
    assert_eq!(header(&route, "cache-control").unwrap(), "no-cache");
    assert_eq!(header(&route, "content-type").unwrap(), "text/html; charset=utf-8");
    let etag = header(&route, "etag").unwrap();
    assert!(etag.starts_with("W/\"") && etag.len() == 36, "{etag}");
    assert_eq!(body(route).await, b"<html>bb</html>");

    let forever = "public, max-age=31536000, immutable";
    for coding in ["br", "gzip"] {
        let accept = format!("{coding}, deflate");
        let accept = [("accept-encoding", accept.as_str())];
        let packed = get(&app, Method::GET, "/assets/app-abc.js", &accept).await;
        assert_eq!(header(&packed, "content-encoding").as_deref(), Some(coding));
        assert_eq!(header(&packed, "cache-control").unwrap(), forever);
        assert_eq!(header(&packed, "vary").unwrap(), "accept-encoding");
        assert_eq!(decode(Some(coding), &body(packed).await), script);
    }
    for (path, accept) in [("/assets/app-abc.js", "identity"), ("/assets/logo.png", "br")] {
        let plain = get(&app, Method::GET, path, &[("accept-encoding", accept)]).await;
        assert_eq!(header(&plain, "content-encoding"), None);
        assert_eq!(header(&plain, "cache-control").unwrap(), forever);
        assert_eq!(header(&plain, "vary").is_some(), path.ends_with(".js"));
        assert_eq!(body(plain).await, script.as_bytes());
    }
    let small = get(&app, Method::GET, "/small.css", &[("accept-encoding", "br")]).await;
    assert_eq!(header(&small, "cache-control").unwrap(), "public, max-age=86400");
    assert_eq!(header(&small, "content-type").unwrap(), "text/css; charset=utf-8");
    assert_eq!((header(&small, "content-encoding"), header(&small, "vary")), (None, None));

    for missing in ["/assets/app-old.js", "/assets/..%2F..%2Fsecret.txt", "/bad%zz", "/%C0"] {
        let response = get(&app, Method::GET, missing, &[]).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{missing}");
        let error = body(response).await;
        assert_eq!(error, br#"{"code":"not_found","message":"Not found"}"#);
    }
    let escaped = get(&app, Method::GET, "/..%2Fsecret.txt", &[]).await;
    assert_eq!(body(escaped).await, b"<html>bb</html>");
    let posted = get(&app, Method::POST, "/index.html", &[]).await;
    assert_eq!(posted.status(), StatusCode::NOT_FOUND);

    let tags = format!("\"other\", {}", etag.replace("W/", ""));
    let cached = get(&app, Method::GET, "/", &[("if-none-match", &tags)]).await;
    assert_eq!(cached.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(header(&cached, "content-type"), None);
    assert_eq!(header(&cached, "etag").unwrap(), etag);
    let head = get(&app, Method::HEAD, "/", &[]).await;
    assert_eq!(head.status(), StatusCode::OK);
}

#[tokio::test]
async fn answers_without_a_built_app() {
    let empty = tempfile::tempdir().unwrap();
    let app = app(empty.path());
    let root = get(&app, Method::GET, "/", &[]).await;
    assert_eq!(header(&root, "content-type").unwrap(), "text/plain; charset=UTF-8");
    assert_eq!(body(root).await, b"bb server");
    let index = get(&app, Method::GET, "/index.html", &[]).await;
    assert_eq!(index.status(), StatusCode::OK);
    let other = get(&app, Method::GET, "/threads", &[]).await;
    assert_eq!(other.status(), StatusCode::NOT_FOUND);
}
