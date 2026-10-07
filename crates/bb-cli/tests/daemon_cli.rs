use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::process::{Command, Output, Stdio};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::Value;

fn bb(home: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_bb"));
    for (name, _) in std::env::vars() {
        let scrubbed = ["BB_", "ANTHROPIC_", "CLAUDE_"].iter().any(|p| name.starts_with(p));
        if scrubbed {
            command.env_remove(name);
        }
    }
    command
        .env("HOME", home)
        .env("BB_DATA_DIR", home.join("data"))
        .env("BB_SERVER_PORT", "0")
        .env("BB_SERVER_URL", "http://127.0.0.1:9")
        .stdin(Stdio::null());
    command
}

fn run(home: &Path, args: &[&str]) -> Output {
    bb(home).args(args).output().expect("spawn bb")
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

#[test]
fn runner_run_without_a_joined_server_fails() {
    let home = tempfile::tempdir().unwrap();
    let output = run(home.path(), &["runner", "run"]);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        stderr(&output),
        "Error: This machine has not joined exactly one server.\n\
         Pass --data-dir <dir>. Joined: none\n"
    );
}

#[test]
fn runner_run_without_runner_json_fails() {
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().join("runner");
    std::fs::create_dir_all(&dir).unwrap();
    let output = run(home.path(), &["runner", "run", "--data-dir", dir.to_str().unwrap()]);
    assert_eq!(output.status.code(), Some(1));
    let file = dir.join("runner.json");
    let expected = format!("Error: ENOENT: no such file or directory, open '{}'\n", file.display());
    assert_eq!(stderr(&output), expected);
}

#[test]
fn runner_join_rejects_a_malformed_blob() {
    let home = tempfile::tempdir().unwrap();
    let output = run(home.path(), &["runner", "join", "not-a-blob!"]);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        stderr(&output),
        "Error: Invalid join command: Invalid input: expected object, received string\n"
    );
    let blob = URL_SAFE_NO_PAD.encode(r#"{"serverUrl":"nope"}"#);
    let output = run(home.path(), &["runner", "join", &blob]);
    assert_eq!(stderr(&output), "Error: Invalid join command (serverUrl): Invalid URL\n");
    let blob = URL_SAFE_NO_PAD.encode(r#"{"hostId":"host_1"}"#);
    let output = run(home.path(), &["runner", "join", &blob]);
    assert_eq!(
        stderr(&output),
        "Error: Invalid join command (serverUrl): Invalid input: expected string, received \
         undefined\n"
    );
}

fn get(url: &str, path: &str) -> String {
    let address = url.trim_start_matches("http://").trim_end_matches('/');
    let mut stream = TcpStream::connect(address).unwrap();
    write!(stream, "GET {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n").unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    response
}

#[test]
#[ignore = "needs start_server"]
fn server_listens_and_stops_on_sigterm() {
    let home = tempfile::tempdir().unwrap();
    let mut child = bb(home.path()).arg("server").stdout(Stdio::piped()).spawn().unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut lines = BufReader::new(stdout).lines();
    let url = loop {
        let line = lines.next().expect("server exited before listening").unwrap();
        let Ok(entry) = serde_json::from_str::<Value>(&line) else { continue };
        if entry["message"] == "bb server listening" {
            break entry["url"].as_str().unwrap().to_owned();
        }
    };
    let response = get(&url, "/health");
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGTERM) };
    let status = child.wait().unwrap();
    assert_eq!(status.code(), Some(0));
}
