mod support;

use bb_cli::call::CliEnv;
use serde_json::{Value, json};
use support::{FakeServer, Request, route, run};

fn request(method: &str, path: &str, body: Option<Value>) -> Request {
    Request { method: method.into(), path: path.into(), body }
}

#[test]
fn terminal_list_create_send_output_and_wait() {
    let sessions = json!({ "sessions": [{ "id": "term_1", "title": "sh", "status": "running",
        "exitCode": null }] });
    let output = json!({ "chunks": [{ "dataBase64": "aGkK" }], "status": "running",
        "nextSeq": 3, "exitCode": null });
    let server = FakeServer::start(vec![
        route("GET", "/terminals", sessions),
        route("POST", "/terminals", json!({ "id": "term_1", "title": "ls" })),
        route("POST", "/terminals/term_1/input", json!({ "id": "term_1" })),
        route("GET", "/terminals/term_1/output", output),
    ]);
    let env = CliEnv::default;
    let (result, printed) = run(&server, &["terminal", "list", "--thread", "thr_1"], env());
    result.unwrap();
    assert_eq!(printed, "\nID      TITLE  STATUS   EXITCODE\nterm_1  sh     running  -\n\n");
    let (result, _) = run(&server, &["terminal", "list"], env());
    let error = result.unwrap_err();
    assert_eq!(error.message, "Provide exactly one of --thread, --environment, --machine.");
    assert_eq!(error.code, "missing_required");
    let words = ["terminal", "create", "--thread", "thr_1", "--command", "ls -la"];
    let (result, printed) = run(&server, &words, env());
    result.unwrap();
    assert_eq!(printed, "Created terminal term_1 (ls)\n");
    let words = ["terminal", "send", "term_1", "--text", "hi", "--enter"];
    let (result, printed) = run(&server, &words, env());
    result.unwrap();
    assert_eq!(printed, "Sent input to terminal term_1\n");
    let (result, printed) = run(&server, &["terminal", "output", "term_1"], env());
    result.unwrap();
    assert_eq!(printed, "hi\n");
    let words = ["terminal", "wait", "term_1", "--contains", "hi", "--from-start"];
    let (result, printed) = run(&server, &words, env());
    result.unwrap();
    assert_eq!(printed, "Terminal term_1 matched hi\n");
    let start = json!({ "mode": "command", "command": "ls -la" });
    let target = json!({ "kind": "thread", "threadId": "thr_1" });
    assert_eq!(
        server.requests(),
        [
            request("GET", "/terminals?threadId=thr_1", None),
            request(
                "POST",
                "/terminals",
                Some(json!({ "cols": 80, "rows": 24, "start": start, "target": target }))
            ),
            request("POST", "/terminals/term_1/input", Some(json!({ "dataBase64": "aGkK" }))),
            request("GET", "/terminals/term_1/output", None),
            request("GET", "/terminals/term_1/output?sinceSeq=0", None),
        ]
    );
}
