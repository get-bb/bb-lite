mod support;

use serde_json::{Value, json};
use support::{Fake, fail, ok};

fn routed() -> Fake {
    Fake::start(|request| {
        let answer = match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/threads/thr_1") => json!({ "id": "thr_1", "projectId": "proj_t" }),
            ("POST", path) if path.ends_with("/attachments") => {
                let Some(Value::String(body)) = &request.body else { return (400, "{}".into()) };
                let name = body.split("filename=\"").nth(1).and_then(|r| r.split('"').next());
                json!({ "path": format!("/store/{}", name.unwrap_or("?")) })
            }
            ("POST", "/threads") => json!({ "id": "thr_new", "status": "starting" }),
            _ => json!({ "id": "thr_1", "status": "active", "delivery": "steered" }),
        };
        (200, answer.to_string())
    })
}

fn input_of(fake: &Fake, path: &str) -> Value {
    let request = fake.requests().into_iter().find(|r| r.path == path).expect("request");
    request.body.expect("body")["input"].clone()
}

#[test]
fn spawn_uploads_absolute_and_file_url_attachments_into_its_project() {
    let dir = tempfile::tempdir().unwrap();
    let notes = dir.path().join("notes.txt");
    let image = dir.path().join("my shot.png");
    std::fs::write(&notes, "some notes").unwrap();
    std::fs::write(&image, [0x89, b'P', b'N', b'G']).unwrap();
    let url = format!("file://{}", image.display().to_string().replace(' ', "%20"));
    let fake = routed();
    let argv = [
        "thread",
        "spawn",
        "--project",
        "proj_1",
        "--prompt",
        "look",
        "--file",
        notes.to_str().unwrap(),
        "--file",
        "relative/kept.txt",
        "--image",
        &url,
    ];
    ok(&fake.url, None, &argv);
    let uploads: Vec<_> =
        fake.requests().into_iter().filter(|r| r.path.ends_with("/attachments")).collect();
    assert_eq!(uploads.len(), 2);
    assert!(uploads.iter().all(|r| r.path == "/projects/proj_1/attachments"));
    let Some(Value::String(body)) = &uploads[0].body else { panic!("no body") };
    assert!(body.contains("filename=\"notes.txt\"\r\n"), "{body}");
    assert!(body.contains("\r\n\r\nsome notes\r\n--"), "{body}");
    assert_eq!(
        input_of(&fake, "/threads"),
        json!([
            { "type": "text", "text": "look", "mentions": [] },
            { "type": "localFile", "path": "/store/notes.txt" },
            { "type": "localFile", "path": "relative/kept.txt" },
            { "type": "localImage", "path": "/store/my shot.png" },
        ])
    );
}

#[test]
fn tell_looks_up_the_thread_project_only_for_local_attachments() {
    let dir = tempfile::tempdir().unwrap();
    let notes = dir.path().join("notes.txt");
    std::fs::write(&notes, "n").unwrap();
    let fake = routed();
    ok(&fake.url, None, &["thread", "tell", "thr_1", "hi", "--image", "shots/a.png"]);
    assert!(fake.requests().iter().all(|r| r.method != "GET"));
    let fake = routed();
    ok(&fake.url, None, &["thread", "tell", "thr_1", "hi", "--file", notes.to_str().unwrap()]);
    let paths: Vec<_> = fake.requests().into_iter().map(|r| (r.method, r.path)).collect();
    assert_eq!(paths[0], ("GET".to_string(), "/threads/thr_1".to_string()));
    assert_eq!(paths[1], ("POST".to_string(), "/projects/proj_t/attachments".to_string()));
    assert_eq!(
        input_of(&fake, "/threads/thr_1/send")[1],
        json!({ "type": "localFile", "path": "/store/notes.txt" })
    );
}

#[test]
fn local_attachment_errors_match_node() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("missing.txt");
    let fake = routed();
    let base = ["thread", "spawn", "--project", "proj_1", "--prompt", "x", "--file"];
    let error = fail(&fake.url, None, &[&base[..], &[missing.to_str().unwrap()]].concat());
    let expected = format!("ENOENT: no such file or directory, open '{}'", missing.display());
    assert_eq!(error.message, expected);
    let error = fail(&fake.url, None, &[&base[..], &[dir.path().to_str().unwrap()]].concat());
    assert_eq!(error.message, "EISDIR: illegal operation on a directory, read");
    let error = fail(&fake.url, None, &[&base[..], &["file://elsewhere/tmp/a"]].concat());
    assert_eq!(error.message, "File URL host must be \"localhost\" or empty on linux");
    let error = fail(&fake.url, None, &[&base[..], &["file:///tmp/a%2Fb"]].concat());
    assert_eq!(error.message, "File URL path must not include encoded / characters");
    assert!(fake.requests().is_empty());
}
