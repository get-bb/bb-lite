mod support_b;

use bb_cli::call::CliEnv;
use bb_cli::sha256::sha256_hex;
use serde_json::json;
use support_b::{FakeServer, route, run};

#[test]
fn thread_retry_posts_to_the_retry_route() {
    let server = FakeServer::start(vec![route(
        "POST",
        "/threads/thr_1/retry",
        json!({ "delivery": "sent" }),
    )]);
    let (result, printed) = run(&server, &["thread", "retry", "thr_1"], CliEnv::default());
    result.unwrap();
    assert_eq!(printed, "Thread thr_1 retry sent\n");
    let (result, printed) =
        run(&server, &["thread", "retry", "thr_1", "--json"], CliEnv::default());
    result.unwrap();
    let data: serde_json::Value = serde_json::from_str(&printed).unwrap();
    assert_eq!(data, json!({ "threadId": "thr_1", "delivery": "sent" }));
}

#[test]
fn plugin_config_shows_sets_and_refuses_unknown_settings() {
    let settings = json!({
        "schema": { "limit": { "type": "number" }, "token": { "type": "secret" } },
        "values": { "limit": 5, "token": { "set": false } },
    });
    let server = FakeServer::start(vec![
        route("GET", "/plugins/github/settings", settings.clone()),
        route("PUT", "/plugins/github/settings", settings),
    ]);
    let (result, printed) = run(&server, &["plugin", "config", "github"], CliEnv::default());
    result.unwrap();
    assert_eq!(printed, "limit = 5\ntoken = (secret, unset)\n");
    let words = ["plugin", "config", "github", "set", "limit", "7", "--project", "prj_1"];
    run(&server, &words, CliEnv::default()).0.unwrap();
    let put = server.requests().into_iter().find(|r| r.method == "PUT").unwrap();
    assert_eq!(put.body, Some(json!({ "values": { "limit": 7 }, "projectId": "prj_1" })));
    let words = ["plugin", "config", "github", "set", "limit", "many"];
    let error = run(&server, &words, CliEnv::default()).0.unwrap_err();
    assert_eq!(error.message, "Setting 'limit' needs a number, not 'many'.");
    let words = ["plugin", "config", "github", "unset", "nope"];
    let error = run(&server, &words, CliEnv::default()).0.unwrap_err();
    assert_eq!(error.message, "Unknown setting 'nope'.");
    assert_eq!(error.hint.as_deref(), Some("Known: limit, token"));
}

#[test]
fn file_write_conflict_is_an_error_with_code_conflict() {
    let answer = json!({ "outcome": "conflict", "currentSha256": "abc" });
    let server = FakeServer::start(vec![route("POST", "/machines/files/write", answer)]);
    let words = ["file", "write", "/tmp/x", "--content", "hi", "--expected-sha256", "0"];
    let error = run(&server, &words, CliEnv::default()).0.unwrap_err();
    assert_eq!(error.message, "Write conflict for /tmp/x");
    assert_eq!(error.code, "conflict");
    assert_eq!(error.hint.as_deref(), Some("The file's current SHA-256 is abc."));
}

#[test]
fn sha256_matches_known_digests() {
    let empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    assert_eq!(sha256_hex(b""), empty);
    let abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    assert_eq!(sha256_hex(b"abc"), abc);
    let long = sha256_hex(&[b'a'; 1000]);
    assert_eq!(long, "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
}
