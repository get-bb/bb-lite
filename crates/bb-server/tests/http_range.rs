use axum::body::{Body, Bytes};
use axum::response::Response;
use bb_core::{RunnerError, RunnerErrorCode};
use bb_server::http::file_bytes::{
    FileBytes, file_error, relative_file_segments, revision_ref, serve_file_bytes,
};
use bb_server::http::range::{
    ByteRange, FileResponseOptions, ParsedRange, file_response, matches_entity_tag,
    parse_single_range, select_range,
};
use http::{HeaderMap, Method};

async fn text(response: Response) -> String {
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    String::from_utf8(body.to_vec()).unwrap()
}

fn header(response: &Response, name: &str) -> String {
    response.headers().get(name).map(|v| v.to_str().unwrap().to_owned()).unwrap_or_default()
}

#[test]
fn parses_single_ranges() {
    let bytes = |start, end| ParsedRange::Bytes(ByteRange { start, end });
    assert_eq!(parse_single_range(Some("bytes=2-5"), 10), bytes(2, 5));
    assert_eq!(parse_single_range(Some(" bytes=-3 "), 10), bytes(7, 9));
    assert_eq!(parse_single_range(Some("bytes=8-"), 10), bytes(8, 9));
    assert_eq!(parse_single_range(Some("bytes=2-99999999999999999999999"), 10), bytes(2, 9));
    assert_eq!(parse_single_range(Some("bytes=-50"), 10), bytes(0, 9));
    assert_eq!(parse_single_range(Some("bytes=10-12"), 10), ParsedRange::Unsatisfiable);
    assert_eq!(parse_single_range(Some("bytes=5-2"), 10), ParsedRange::Unsatisfiable);
    assert_eq!(parse_single_range(Some("bytes=-0"), 10), ParsedRange::Unsatisfiable);
    assert_eq!(parse_single_range(Some("bytes=0-"), 0), ParsedRange::Unsatisfiable);
    for whole in [
        None,
        Some(""),
        Some("bytes=-"),
        Some("bytes=0-1,3-4"),
        Some("items=0-1"),
        Some("bytes=a-1"),
    ] {
        assert_eq!(parse_single_range(whole, 10), ParsedRange::Whole, "{whole:?}");
    }
}

#[test]
fn selects_ranges_into_headers() {
    let mut headers = HeaderMap::new();
    let selected = select_range(&mut headers, Some("bytes=10-12"), 10);
    assert_eq!((selected, &headers["content-range"]), (None, &"bytes */10".parse().unwrap()));
    let mut headers = HeaderMap::new();
    let selected = select_range(&mut headers, None, 0).unwrap();
    assert_eq!((selected.status, &headers["content-length"]), (200, &"0".parse().unwrap()));
    assert!(!headers.contains_key("content-range"));
    let mut headers = HeaderMap::new();
    let selected = select_range(&mut headers, Some("bytes=2-5"), 10).unwrap();
    assert_eq!((selected.start, selected.end, selected.status), (2, 5, 206));
    assert_eq!(headers["content-range"], "bytes 2-5/10");
    assert_eq!(headers["content-length"], "4");
}

#[test]
fn matches_entity_tags() {
    assert!(matches_entity_tag(Some("\"other\", \"abc\""), "W/\"abc\""));
    assert!(matches_entity_tag(Some("W/\"abc\""), "\"abc\""));
    assert!(matches_entity_tag(Some("*"), "\"abc\""));
    assert!(!matches_entity_tag(Some("\"abd\""), "\"abc\""));
    assert!(!matches_entity_tag(None, "\"abc\""));
}

#[tokio::test]
async fn answers_files_from_disk_with_ranges() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("digits.txt");
    std::fs::write(&path, "0123456789").unwrap();
    let options = |range| FileResponseOptions {
        range,
        if_none_match: None,
        content_type: "text/plain",
        cache_control: "private",
    };
    let read = |range: Option<&'static str>| {
        let path = path.clone();
        async move {
            let response = file_response(&path, options(range)).await.unwrap();
            let status = response.status().as_u16();
            let span = header(&response, "content-range");
            format!("{status}|{span}|{}", text(response).await)
        }
    };
    assert_eq!(read(Some("bytes=2-5")).await, "206|bytes 2-5/10|2345");
    assert_eq!(read(Some("bytes=-3")).await, "206|bytes 7-9/10|789");
    assert_eq!(read(Some("bytes=8-")).await, "206|bytes 8-9/10|89");
    assert_eq!(read(Some("bytes=10-12")).await, "416|bytes */10|");
    assert_eq!(read(None).await, "200||0123456789");
    let whole = file_response(&path, options(None)).await.unwrap();
    let etag = header(&whole, "etag");
    assert!(etag.starts_with("\"a-"), "{etag}");
    assert_eq!(header(&whole, "accept-ranges"), "bytes");
    let tags = format!("\"x\", {etag}");
    let cached = FileResponseOptions { if_none_match: Some(&tags), ..options(None) };
    assert_eq!(file_response(&path, cached).await.unwrap().status(), 304);
    let weak = format!("W/{etag}");
    let weak = FileResponseOptions { if_none_match: Some(&weak), ..options(None) };
    assert_eq!(file_response(&path, weak).await.unwrap().status(), 200);
    assert!(file_response(dir.path(), options(None)).await.is_none());
    assert!(file_response(&dir.path().join("nope"), options(None)).await.is_none());
}

fn file(content: &'static str, mime: Option<&str>) -> FileBytes {
    FileBytes {
        content: Bytes::from_static(content.as_bytes()),
        mime_type: mime.map(str::to_owned),
        size_bytes: content.len() as u64,
        modified_at_ms: Some(1_760_000_000_123.0),
        revision: "abc123".to_owned(),
    }
}

fn request(pairs: &[(&str, &str)]) -> HeaderMap {
    let mut headers = HeaderMap::new();
    for (name, value) in pairs {
        headers
            .append(http::HeaderName::from_bytes(name.as_bytes()).unwrap(), value.parse().unwrap());
    }
    headers
}

#[tokio::test]
async fn serves_file_bytes() {
    let digits = file("0123456789", Some("text/plain"));
    let response = serve_file_bytes(&Method::GET, &request(&[]), &digits).unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(header(&response, "etag"), "W/\"file-abc123\"");
    assert_eq!(header(&response, "cache-control"), "private, no-cache");
    assert_eq!(header(&response, "content-security-policy"), "sandbox allow-scripts");
    assert_eq!(header(&response, "x-content-type-options"), "nosniff");
    assert_eq!(header(&response, "last-modified"), "Thu, 09 Oct 2025 08:53:20 GMT");
    assert_eq!(header(&response, "content-length"), "10");
    assert_eq!(text(response).await, "0123456789");

    let ranged = serve_file_bytes(&Method::GET, &request(&[("range", "bytes=2-5")]), &digits);
    let ranged = ranged.unwrap();
    assert_eq!(
        (ranged.status().as_u16(), header(&ranged, "content-range")),
        (206, "bytes 2-5/10".into())
    );
    assert_eq!(text(ranged).await, "2345");
    let unsatisfiable = request(&[("range", "bytes=10-12")]);
    let refused = serve_file_bytes(&Method::GET, &unsatisfiable, &digits).unwrap();
    assert_eq!(refused.status(), 416);
    assert_eq!(header(&refused, "content-length"), "0");
    assert_eq!(header(&refused, "content-range"), "bytes */10");
    let conditional = request(&[("range", "bytes=2-5"), ("if-range", "\"x\"")]);
    let whole = serve_file_bytes(&Method::GET, &conditional, &digits).unwrap();
    assert_eq!(whole.status(), 200);
    let head = serve_file_bytes(&Method::HEAD, &request(&[("range", "bytes=0-1")]), &digits);
    let head = head.unwrap();
    assert_eq!((head.status().as_u16(), header(&head, "content-length")), (200, "10".into()));
    assert_eq!(text(head).await, "");
    let cached = request(&[("if-none-match", "\"file-abc123\"")]);
    assert_eq!(serve_file_bytes(&Method::GET, &cached, &digits).unwrap().status(), 304);

    let page = file("<p>hi</p>", Some("Text/HTML; charset=latin1"));
    let cached = request(&[("if-none-match", "W/\"file-abc123\"")]);
    let html = serve_file_bytes(&Method::GET, &cached, &page).unwrap();
    assert_eq!(html.status(), 200);
    assert_eq!(header(&html, "cache-control"), "no-store");
    assert_eq!(header(&html, "content-type"), "text/html; charset=utf-8");

    let mut unknown = file("", None);
    unknown.modified_at_ms = None;
    let empty = serve_file_bytes(&Method::GET, &request(&[]), &unknown).unwrap();
    assert_eq!(header(&empty, "content-type"), "application/octet-stream");
    assert_eq!(header(&empty, "last-modified"), "");
    assert_eq!(text(empty).await, "");

    let mut short = file("0123", Some("text/plain"));
    short.size_bytes = 10;
    let changed = serve_file_bytes(&Method::GET, &request(&[]), &short).unwrap_err();
    assert_eq!((changed.status, changed.body.code.as_str()), (409, "file_changed"));
    assert_eq!(changed.body.retryable, Some(true));
    let _ = Body::empty();
}

#[test]
fn file_paths_refs_and_errors() {
    assert_eq!(relative_file_segments("a\\b/c.txt").unwrap(), ["a", "b", "c.txt"]);
    for unsafe_path in ["", "/abs", "a//b", "a/./b", "../x", "a/..", "a\0b", "a/"] {
        let error = relative_file_segments(unsafe_path).unwrap_err();
        assert_eq!(
            (error.status, error.body.code.as_str()),
            (400, "invalid_path"),
            "{unsafe_path:?}"
        );
        assert_eq!(error.body.message, "Invalid file path");
        assert_eq!(error.body.retryable, Some(false));
    }
    for good in ["HEAD", "head", "abcd", "ABCDEF0123456789abcdef0123456789abcdef01"] {
        assert_eq!(revision_ref(good).unwrap(), good);
    }
    for bad in ["abc", "main", "HEAD~1", "abcdef0123456789abcdef0123456789abcdef012"] {
        let error = revision_ref(bad).unwrap_err();
        assert_eq!((error.status, error.body.code.as_str()), (400, "invalid_ref"), "{bad}");
        assert_eq!(error.body.message, "Invalid revision");
    }
    let mapped = |code| {
        let error = file_error(RunnerError::new(code, "boom"));
        (error.status, error.body.code, error.body.retryable)
    };
    assert_eq!(mapped(RunnerErrorCode::InvalidPath), (400, "invalid_path".into(), Some(false)));
    assert_eq!(
        mapped(RunnerErrorCode::PermissionDenied),
        (403, "permission_denied".into(), Some(false))
    );
    assert_eq!(mapped(RunnerErrorCode::FileTooLarge), (413, "file_too_large".into(), Some(false)));
    assert_eq!(mapped(RunnerErrorCode::Conflict), (409, "file_changed".into(), Some(true)));
    assert_eq!(mapped(RunnerErrorCode::PathNotFound).0, 404);
}
