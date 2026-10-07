use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

struct Bb {
    home: tempfile::TempDir,
    server: Child,
    url: String,
    project: String,
}

impl Drop for Bb {
    fn drop(&mut self) {
        let _ = self.server.kill();
        let _ = self.server.wait();
    }
}

struct Ran {
    code: i32,
    stdout: String,
    stderr: String,
}

impl Ran {
    fn json(&self) -> Value {
        serde_json::from_str(&self.stdout).unwrap_or_else(|_| panic!("not JSON: {self:?}"))
    }
}

impl std::fmt::Debug for Ran {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "code {} stdout {:?} stderr {:?}", self.code, self.stdout, self.stderr)
    }
}

fn command(home: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_bb"));
    for (name, _) in std::env::vars() {
        if ["BB_", "ANTHROPIC_", "CLAUDE_", "OPENAI_", "CODEX_"].iter().any(|p| name.starts_with(p))
        {
            command.env_remove(name);
        }
    }
    command
        .env("HOME", home)
        .env("BB_DATA_DIR", home.join("data"))
        .env("BB_SERVER_PORT", "0")
        .env("BB_DEV_PROVIDERS", "echo")
        .env("BB_SERVER_URL", "http://127.0.0.1:9");
    command
}

impl Bb {
    fn start() -> Bb {
        let home = tempfile::tempdir().unwrap();
        let mut server = command(home.path())
            .arg("server")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut lines = BufReader::new(server.stdout.take().unwrap()).lines();
        let url = loop {
            let line = lines.next().expect("server exited before listening").unwrap();
            let Ok(entry) = serde_json::from_str::<Value>(&line) else { continue };
            if entry["message"] == "bb server listening" {
                break entry["url"].as_str().unwrap().to_owned();
            }
        };
        std::thread::spawn(move || lines.for_each(drop));
        let repo = home.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        let mut bb = Bb { home, server, url, project: String::new() };
        let root = repo.to_str().unwrap().to_owned();
        let created = bb.run(&["project", "create", "--name", "echo", "--root", &root, "--json"]);
        bb.project = created.json()["id"].as_str().expect("project id").to_owned();
        bb
    }

    fn run_with(&self, args: &[&str], env: &[(&str, &str)], stdin: &str) -> Ran {
        let mut command = command(self.home.path());
        command.env("BB_SERVER_URL", &self.url).env("BB_PROJECT_ID", &self.project);
        command.envs(env.iter().copied()).args(args);
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(stdin.as_bytes()).unwrap();
        let output = child.wait_with_output().unwrap();
        let text = |bytes: Vec<u8>| String::from_utf8(bytes).unwrap();
        Ran {
            code: output.status.code().unwrap_or(-1),
            stdout: text(output.stdout),
            stderr: text(output.stderr),
        }
    }

    fn run(&self, args: &[&str]) -> Ran {
        self.run_with(args, &[], "")
    }
}

fn wait_for(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(250));
    }
}

fn matches(actual: &Value, expected: &Value) -> bool {
    match expected {
        Value::Object(fields) => fields.iter().all(|(k, v)| matches(&actual[k], v)),
        _ => actual == expected,
    }
}

#[test]
fn runs_the_canonical_agent_recipes_against_the_echo_provider() {
    let bb = Bb::start();
    let project = bb.project.clone();
    let spawn = ["thread", "spawn", "--project", &project, "--provider", "echo"];
    let parent = bb.run(&[&spawn[..], &["--prompt", "parent ready", "--json"]].concat()).json();
    let parent = parent["id"].as_str().unwrap().to_owned();
    let idle = ["--status", "idle", "--timeout", "30s", "--poll-interval", "100ms", "--json"];
    let waited = bb.run(&[&["thread", "wait", &parent][..], &idle].concat());
    let matched = json!({ "threadId": parent, "matched": true,
        "target": { "kind": "status", "status": "idle" } });
    assert_eq!((waited.code, waited.json()), (0, matched));
    let shown = bb.run(&["thread", "show", &parent, "--json"]).json();
    let environment = shown["environment"]["id"].as_str().unwrap().to_owned();
    let self_env = [("BB_THREAD_ID", parent.as_str()), ("BB_ENVIRONMENT_ID", &environment)];
    let place = ["--parent-self", "--environment", &environment];
    let brief = ["--title", "child", "--prompt-file", "-"];
    let worker = [&spawn[..], &place, &brief].concat();
    let spawned = bb.run_with(&worker, &self_env, "hold_turn child task\n");
    assert!(spawned.stdout.contains("You will be notified when this thread is done."));
    let child = spawned.stdout.split("Thread spawned: ").nth(1).unwrap_or_default();
    let child: String = child.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
    assert!(child.starts_with("thr_"), "{spawned:?}");
    wait_for("the child turn", || {
        let events = bb.run(&["thread", "log", &child, "--format", "json"]);
        events.stdout.contains("turn/started")
    });
    let tell = ["thread", "tell", &child];
    let later = bb.run_with(
        &[&tell[..], &["queued note", "--mode", "queue", "--json"]].concat(),
        &self_env,
        "",
    );
    let queued = json!({ "threadId": child, "delivery": "queued", "mode": "queue",
        "queuedMessage": { "threadId": child, "senderThreadId": parent } });
    assert!(matches(&later.json(), &queued), "{later:?}");
    let steer = [&tell[..], &["--message-file", "-", "--mode", "steer", "--json"]].concat();
    let steered = bb.run_with(&steer, &self_env, "finish release_turn");
    let sent = json!({ "threadId": child, "delivery": "sent", "mode": "steer" });
    assert!(matches(&steered.json(), &sent), "{steered:?}");
    wait_for("the queued note", || {
        bb.run(&["thread", "output", &child]).stdout.contains("queued note")
    });
    let settled = bb.run(&["thread", "wait", &child, "--timeout", "30"]);
    assert_eq!(settled.stdout, format!("Thread {child} reached status idle.\n"));
    let result = bb.run(&["thread", "output", &child, "--json"]).json();
    let from = format!("[bb message from thread:{parent}]");
    assert!(result["output"].as_str().unwrap().contains(&from), "{result}");
    let log = bb.run(&["thread", "log", &child, "--json"]).json();
    let log = log.as_array().unwrap();
    let types: Vec<&str> = log.iter().filter_map(|e| e["type"].as_str()).collect();
    assert!(types.contains(&"client/turn/requested") && types.contains(&"turn/completed"));
    let sequences: Vec<i64> = log.iter().filter_map(|e| e["seq"].as_i64()).collect();
    assert!(sequences.is_sorted(), "{sequences:?}");
    let family = ["thread", "list", "--parent-thread", &parent, "--include-hidden", "--json"];
    let children = bb.run(&family).json();
    assert_eq!(children.as_array().unwrap().len(), 1);
    assert_eq!(children[0]["id"], child.as_str());
    let machines = bb.run(&["machine", "list", "--json"]).json();
    let host = machines[0]["name"].as_str().unwrap_or_default().to_owned();
    let fresh = ["--machine", &host, "--new-environment", "worktree"];
    let branch = ["--base-branch", "origin/main", "--prompt", "x", "--json"];
    let isolated = bb.run(&[&spawn[..], &fresh, &branch].concat());
    let accepted = json!({ "projectId": project, "parentThreadId": null });
    assert!(matches(&isolated.json(), &accepted), "{isolated:?}");
    let archived =
        bb.run_with(&["thread", "archive", "--self", "--json"], &[("BB_THREAD_ID", &child)], "");
    let gone = json!({ "ok": true, "threadId": child, "archivedThreadIds": [child] });
    assert_eq!(archived.json(), gone);
}

#[test]
fn reports_failures_as_a_json_envelope_with_the_documented_exit_codes() {
    let bb = Bb::start();
    let missing = bb.run(&["thread", "tell", "thr_missing", "hi", "--json"]);
    let error = &missing.json()["error"];
    assert_eq!(
        (missing.json()["ok"].clone(), error["code"].clone()),
        (json!(false), json!("thread_not_found"))
    );
    assert!(error["message"].as_str().unwrap().contains("Thread not found"));
    assert_eq!(missing.code, 1);
    assert!(missing.stderr.starts_with("Error: ") && missing.stderr.contains("Thread not found"));
    let project = bb.project.clone();
    let hold = ["thread", "spawn", "--project", &project, "--json", "--provider", "echo"];
    let held = bb.run(&[&hold[..], &["--prompt", "hold_turn"]].concat()).json();
    let held = held["id"].as_str().unwrap().to_owned();
    let wait = ["thread", "wait", &held];
    let timed_out = bb.run(&[&wait[..], &["--timeout", "1", "--json"]].concat());
    assert_eq!((timed_out.code, timed_out.json()["error"]["code"].clone()), (2, json!("timeout")));
    let invalid = bb.run(&[&wait[..], &["--status", "bogus", "--json"]].concat());
    assert_eq!((invalid.code, invalid.json()["ok"].clone()), (3, json!(false)));
    let both = bb.run(&[&wait[..], &["--status", "idle", "--event", "turn/completed"]].concat());
    assert_eq!(both.code, 3);
    let no_self = bb.run(&["thread", "archive", "--self", "--json"]);
    assert_eq!(no_self.json()["error"]["message"], "--self requires BB_THREAD_ID to be set.");
    let typo = bb.run(&["thread", "spawn", "--promt", "x", "--json"]);
    let suggestion = "Unknown option --promt. Did you mean '--prompt'?";
    assert_eq!(typo.json()["error"]["code"], "unknown_option");
    assert_eq!(typo.json()["error"]["message"], suggestion);
    let unconfirmed = bb.run(&["thread", "delete", &held]);
    assert_eq!(unconfirmed.code, 1);
    assert!(unconfirmed.stderr.contains("Re-run with --yes to confirm."), "{unconfirmed:?}");
    let stopped = bb.run(&["thread", "stop", &held]);
    assert_eq!(stopped.stdout, format!("Thread {held} stopped\n"));
}

#[test]
fn dispatches_plugin_commands_to_the_server_and_returns_their_exit_code() {
    let bb = Bb::start();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/server/test/fixtures/echo-plugin")
        .canonicalize()
        .unwrap();
    let added = bb.run(&["plugin", "add", fixture.to_str().unwrap(), "--json"]);
    let plugins = added.json()["plugins"].clone();
    let ids: Vec<&str> =
        plugins.as_array().unwrap().iter().filter_map(|p| p["id"].as_str()).collect();
    assert!(ids.contains(&"echo"), "{added:?}");
    let loud = bb.run_with(&["echo", "say", "hi", "--times", "2", "--tone-stdin"], &[], "loud\n");
    assert_eq!((loud.code, loud.stdout.as_str()), (0, "HI HI\n"), "{loud:?}");
    let scoped =
        bb.run_with(&["echo", "say", "hi", "--json"], &[("BB_THREAD_ID", "thr_caller")], "");
    assert_eq!(scoped.json(), json!({ "said": "hi", "threadId": "thr_caller" }));
    let refused = bb.run(&["echo", "say", "nothing"]);
    assert_eq!((refused.code, refused.stderr.as_str()), (3, "Nothing to say\n"));
    let unknown = bb.run(&["nonsense", "--json"]);
    assert_eq!(unknown.json()["error"]["code"], "unknown_command");
}
