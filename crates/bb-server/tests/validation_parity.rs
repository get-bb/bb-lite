//! Sends every invalid request of `fixtures/validation/corpus.json` (generated from the zod schemas
//! of `packages/server-contract`) and compares status, error code and message with the TypeScript
//! server's answer.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use bb_server::config::{ServerEnv, load_config};
use bb_server::providers::catalog::enable_dev_providers_for_tests;
use bb_server::runners::local::local_runner_for;
use bb_server::server::{CreateServerOptions, create_server};
use serde_json::{Value, json};

fn case_key(case: &Value) -> String {
    let input = ["body", "query", "rawBody"].iter().find_map(|key| case.get(*key)).cloned();
    format!("{} {}", case["route"].as_str().unwrap_or_default(), input.unwrap_or(Value::Null))
}

#[tokio::test(flavor = "current_thread")]
async fn invalid_requests_answer_like_zod() {
    let fixture =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/validation/corpus.json");
    let corpus: Value = serde_json::from_str(&std::fs::read_to_string(&fixture).unwrap()).unwrap();
    let cases = corpus["cases"].as_array().unwrap();
    let allowed: Value = serde_json::from_str(
        &std::fs::read_to_string(fixture.with_file_name("allowed.json")).unwrap(),
    )
    .unwrap();
    let allowed: std::collections::HashSet<String> = allowed
        .as_array()
        .unwrap()
        .iter()
        .inspect(|entry| assert!(entry["reason"].as_str().is_some_and(|r| !r.is_empty())))
        .map(case_key)
        .collect();

    let temp_dir = tempfile::Builder::new().prefix("bb-validation-").tempdir().unwrap();
    let temp: PathBuf = temp_dir.path().canonicalize().unwrap();
    let data_dir = temp.join("data");
    let home = temp.join("home");
    for dir in [&data_dir, &home] {
        std::fs::create_dir_all(dir).unwrap();
    }
    enable_dev_providers_for_tests();
    let s = |p: &Path| p.to_string_lossy().into_owned();
    let env: ServerEnv = [
        ("HOME", s(&home)),
        ("PATH", std::env::var("PATH").unwrap_or_default()),
        ("VITEST", "1".to_owned()),
        ("BB_DATA_DIR", s(&data_dir)),
        ("BB_SERVER_PORT", "0".to_owned()),
        ("BB_SERVER_BIND_HOST", "127.0.0.1".to_owned()),
        ("BB_DEV_PROVIDERS", "echo".to_owned()),
        ("BB_LOG_LEVEL", "silent".to_owned()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v))
    .collect();
    let config = load_config(&env).unwrap();
    let adapters = bb_runner::default_adapters()
        .into_iter()
        .filter(|adapter| adapter.id().as_str() == "echo")
        .collect();
    let (connect, _local) = local_runner_for(&config, adapters);
    let mut options = CreateServerOptions::new(config, connect);
    options.now = Some(Arc::new(|| 1_700_000_000_000));
    let server = create_server(options).unwrap();
    let listening = server.listen().await.unwrap();
    let http = reqwest::Client::new();

    let mut mismatches = Vec::new();
    let mut allowed_hits = 0;
    for case in cases {
        let route = case["route"].as_str().unwrap();
        let method =
            reqwest::Method::from_bytes(case["method"].as_str().unwrap().as_bytes()).unwrap();
        let mut url = reqwest::Url::parse(&format!(
            "{}/api/v1{}",
            listening.url,
            case["path"].as_str().unwrap()
        ))
        .unwrap();
        if let Some(query) = case["query"].as_object() {
            let mut pairs = url.query_pairs_mut();
            for (key, value) in query {
                pairs.append_pair(key, value.as_str().unwrap_or_default());
            }
        }
        let mut request = http.request(method, url);
        if let Some(raw) = case["rawBody"].as_str() {
            request = request.header("content-type", "application/json").body(raw.to_owned());
        } else if let Some(body) = case.get("body") {
            request = request.json(body);
        }
        let response = request.send().await.unwrap();
        let status = response.status().as_u16();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        let actual = json!({
            "status": status,
            "code": body["code"],
            "message": body["message"],
        });
        let expected = &case["expected"];
        if &actual == expected {
            continue;
        }
        if allowed.contains(&case_key(case)) {
            allowed_hits += 1;
            continue;
        }
        let kind = if actual["status"] != expected["status"] {
            format!("status {} (expected {})", actual["status"], expected["status"])
        } else if actual["code"] != expected["code"] {
            format!("code {}", actual["code"])
        } else {
            format!("message ({})", case["kind"].as_str().unwrap_or_default())
        };
        mismatches.push(json!({
            "route": route,
            "kind": kind,
            "case": case,
            "actual": actual,
        }));
    }

    let mut by_route: BTreeMap<String, usize> = BTreeMap::new();
    let mut by_kind: BTreeMap<String, usize> = BTreeMap::new();
    for m in &mismatches {
        *by_route.entry(m["route"].as_str().unwrap().to_owned()).or_default() += 1;
        *by_kind.entry(m["kind"].as_str().unwrap().to_owned()).or_default() += 1;
    }
    println!(
        "validation parity: {} cases, {} mismatches, {} allow-listed",
        cases.len(),
        mismatches.len(),
        allowed_hits
    );
    for (kind, n) in &by_kind {
        println!("  kind {kind}: {n}");
    }
    for (route, n) in &by_route {
        println!("  route {route}: {n}");
    }
    if let Ok(report) = std::env::var("VALIDATION_REPORT") {
        let lines: Vec<String> = mismatches.iter().map(Value::to_string).collect();
        std::fs::write(report, lines.join("\n") + "\n").unwrap();
    }
    for m in mismatches.iter().take(10) {
        println!(
            "  {} {} {} -> {}",
            m["route"], m["case"]["kind"], m["case"]["expected"]["message"], m["actual"]
        );
    }
    assert!(mismatches.is_empty(), "{} validation mismatches", mismatches.len());
}
