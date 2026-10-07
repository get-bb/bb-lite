mod support;

use bb_cli::commands::workspace::file_form;
use serde_json::{Value, json};
use support::{Fake, run};

#[test]
fn file_form_matches_form_data() {
    let body = file_form("XYZ", "a\"b.txt", b"hello");
    let expected = "--XYZ\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a%22b.txt\"\r\n\
                    Content-Type: application/octet-stream\r\n\r\nhello\r\n--XYZ--\r\n";
    assert_eq!(String::from_utf8(body).unwrap(), expected);
}

#[test]
fn attachment_upload_posts_a_multipart_form() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("notes.txt");
    std::fs::write(&file, "some notes").unwrap();
    let fake = Fake::json(json!({ "path": "/store/notes.txt", "filename": "notes.txt" }));
    let words =
        ["project", "attachment", "upload", "prj_1", "--client-file", file.to_str().unwrap()];
    let (result, printed) = run(&fake.url, None, &words);
    result.unwrap();
    assert_eq!(printed.trim_end(), "/store/notes.txt");
    let request = fake.only();
    assert_eq!(
        (request.method.as_str(), request.path.as_str()),
        ("POST", "/projects/prj_1/attachments")
    );
    let Some(Value::String(body)) = request.body else { panic!("no body") };
    assert!(body.contains("filename=\"notes.txt\"\r\n"), "{body}");
    assert!(body.contains("\r\n\r\nsome notes\r\n--"), "{body}");
    let missing = dir.path().join("missing.txt");
    let words =
        ["project", "attachment", "upload", "prj_1", "--client-file", missing.to_str().unwrap()];
    let error = run(&fake.url, None, &words).0.unwrap_err();
    let expected = format!("ENOENT: no such file or directory, open '{}'", missing.display());
    assert_eq!(error.message, expected);
}
