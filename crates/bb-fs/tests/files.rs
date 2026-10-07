use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use bb_core::RunnerResult;
use bb_core::env::{EnvMap, fixed_env, process_env, scrub_env};
use bb_core::exec::{Ctx, KeyedLock};
use bb_fs::commands::parse_frontmatter;
use bb_fs::read::sha256_hex;
use bb_fs::*;
use serde_json::{Value, json};

const KIB: usize = 1024;

struct Harness {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    ctx: Ctx,
    env: EnvMap,
}

impl Harness {
    fn new() -> Self {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = std::fs::canonicalize(tmp.path()).expect("realpath");
        let mut env = scrub_env(&process_env());
        for (key, value) in [
            ("GIT_CONFIG_GLOBAL", "/dev/null"),
            ("GIT_CONFIG_NOSYSTEM", "1"),
            ("GIT_AUTHOR_NAME", "Test"),
            ("GIT_AUTHOR_EMAIL", "test@example.com"),
            ("GIT_COMMITTER_NAME", "Test"),
            ("GIT_COMMITTER_EMAIL", "test@example.com"),
        ] {
            env.insert(key.to_owned(), value.to_owned());
        }
        let ctx = Ctx {
            data_dir: root.join("data"),
            sink: Arc::new(|_| {}),
            env: fixed_env(env.clone()),
            lock: KeyedLock::new(),
        };
        Self { _tmp: tmp, root, ctx, env }
    }

    fn write(&self, directory: &Path, files: &[(&str, &[u8])]) {
        for (file, content) in files {
            let target = directory.join(file);
            std::fs::create_dir_all(target.parent().expect("parent")).expect("mkdir");
            std::fs::write(target, content).expect("write");
        }
    }

    fn git(&self, cwd: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env_clear()
            .envs(&self.env)
            .status()
            .expect("git");
        assert!(status.success(), "git {args:?}");
    }

    fn init_repo(&self, name: &str, files: &[(&str, &[u8])]) -> PathBuf {
        let repo = self.root.join(name);
        self.write(&repo, files);
        self.git(&repo, &["init", "--quiet", "-b", "main"]);
        self.git(&repo, &["add", "-A"]);
        self.git(&repo, &["commit", "--quiet", "-m", "initial"]);
        repo
    }
}

fn args<T: serde::de::DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).expect("arguments")
}

fn code<T>(result: RunnerResult<T>) -> String {
    match result {
        Ok(_) => "resolved".to_owned(),
        Err(error) => error.code.as_str().to_owned(),
    }
}

fn files_harness() -> (Harness, PathBuf) {
    let h = Harness::new();
    let root = h.root.join("files");
    h.write(&h.root, &[("files/notes.txt", b"first\n"), ("secret.txt", b"outside\n")]);
    symlink(h.root.join("secret.txt"), root.join("link")).expect("link");
    symlink(h.root.join("created"), root.join("dangling")).expect("dangling");
    (h, root)
}

#[tokio::test]
async fn reads_with_metadata_at_a_git_revision_and_only_inside_the_root() {
    let (h, root) = files_harness();
    let r = root.to_str().expect("utf8");
    let file =
        read_file(&h.ctx, args(json!({ "path": "notes.txt", "rootPath": r }))).await.expect("read");
    let sha256 = sha256_hex("first\n");
    assert_eq!(file.content, "first\n");
    assert_eq!(file.size_bytes, 6);
    assert_eq!(file.sha256, sha256);
    assert_eq!(file.path, "notes.txt");
    assert_eq!(file.mime_type.as_deref(), Some("text/plain"));
    let shape = serde_json::to_value(&file).expect("json");
    assert_eq!(shape["contentEncoding"], "utf8");
    assert!(shape["modifiedAtMs"].is_number());
    let absolute = root.join("notes.txt").to_string_lossy().into_owned();
    let direct = read_file(&h.ctx, args(json!({ "path": absolute }))).await.expect("direct");
    assert_eq!((direct.path, direct.sha256), (absolute, sha256));
    h.write(&root, &[("big.bin", &vec![0u8; 513 * KIB])]);
    let whole = read_file(&h.ctx, args(json!({ "path": "big.bin", "rootPath": r }))).await;
    assert_eq!(code(whole), "file_too_large");

    let repo = h.init_repo("history", &[("src/a.txt", b"committed\n")]);
    h.write(&repo, &[("src/a.txt", b"working\n")]);
    let repo = repo.to_str().expect("utf8");
    let at_head = json!({ "path": "src/a.txt", "rootPath": repo, "gitRef": "HEAD" });
    let old = read_file(&h.ctx, args(at_head.clone())).await.expect("at head");
    assert_eq!((old.content.as_str(), old.size_bytes), ("committed\n", 10));
    assert_eq!(serde_json::to_value(&old).expect("json").get("modifiedAtMs"), None);
    let mut ranged = at_head.clone();
    ranged["offset"] = json!(3);
    ranged["length"] = json!(4);
    ranged["revision"] = Value::Null;
    let chunk = read_file_chunk(&h.ctx, args(ranged)).await.expect("chunk");
    assert_eq!(STANDARD.decode(&chunk.data_base64).expect("base64"), b"mitt");
    assert_eq!(chunk.modified_at_ms, None);

    let secret = h.root.join("secret.txt").to_string_lossy().into_owned();
    let range = json!({ "offset": 3, "length": 4, "revision": null });
    let mut chunk_link = json!({ "path": "link", "rootPath": r });
    chunk_link
        .as_object_mut()
        .expect("object")
        .extend(range.as_object().cloned().unwrap_or_default());
    let mut bad_ref = at_head.clone();
    bad_ref["gitRef"] = json!("--output=x");
    let codes = [
        code(read_file(&h.ctx, args(json!({ "path": "../secret.txt", "rootPath": r }))).await),
        code(read_file(&h.ctx, args(json!({ "path": secret, "rootPath": r }))).await),
        code(read_file(&h.ctx, args(json!({ "path": "link", "rootPath": r }))).await),
        code(read_file(&h.ctx, args(json!({ "path": "notes.txt" }))).await),
        code(read_file(&h.ctx, args(bad_ref)).await),
        code(read_file_chunk(&h.ctx, args(chunk_link)).await),
        code(
            write_file(
                &h.ctx,
                args(json!({ "path": "../escape.txt", "rootPath": r, "content": "x" })),
            )
            .await,
        ),
        code(
            write_file(&h.ctx, args(json!({ "path": "dangling", "rootPath": r, "content": "x" })))
                .await,
        ),
        code(
            mutate_path(&h.ctx, args(json!({ "op": "mkdir", "path": "../made", "rootPath": r })))
                .await,
        ),
        code(
            mutate_path(&h.ctx, args(json!({ "op": "remove", "path": ".", "rootPath": r }))).await,
        ),
    ];
    assert!(codes.iter().all(|code| code == "invalid_path"), "{codes:?}");
}

#[tokio::test]
async fn writes_with_compare_and_set() {
    let (h, root) = files_harness();
    let r = root.to_str().expect("utf8");
    let file = root.join("state/config.json");
    let write = |content: &str, sha: Option<Value>, more: Value| {
        let mut value = json!({ "path": "state/config.json", "rootPath": r, "content": content });
        if let Some(sha) = sha {
            value["expectedSha256"] = sha;
        }
        value
            .as_object_mut()
            .expect("object")
            .extend(more.as_object().cloned().unwrap_or_default());
        write_file(&h.ctx, args(value))
    };
    assert_eq!(code(write("{}", None, json!({})).await), "path_not_found");
    let fresh = json!({ "createParents": true, "mode": 0o664, "expectedSha256": null });
    let created = write("{}", None, fresh).await.expect("created");
    let sha256 = sha256_hex("{}");
    assert_eq!(
        serde_json::to_value(&created).expect("json"),
        json!({ "outcome": "written", "sha256": sha256, "sizeBytes": 2 })
    );
    let conflict = json!({ "outcome": "conflict", "currentSha256": sha256 });
    let racing = write("x", Some(Value::Null), json!({})).await.expect("null");
    assert_eq!(serde_json::to_value(&racing).expect("json"), conflict);
    let stale = write("x", Some(json!(sha256_hex("stale"))), json!({})).await.expect("stale");
    assert_eq!(serde_json::to_value(&stale).expect("json"), conflict);
    assert_eq!(std::fs::read_to_string(&file).expect("read"), "{}");
    let next = write("{\"a\":1}", Some(json!(sha256)), json!({})).await.expect("next");
    assert!(matches!(next, FileWriteResult::Written { .. }));
    assert_eq!(std::fs::read_to_string(&file).expect("read"), "{\"a\":1}");
    let mode = std::fs::metadata(&file).expect("stat").permissions().mode() & 0o777;
    assert_eq!(mode, 0o664);
    let names: Vec<_> = std::fs::read_dir(file.parent().expect("parent"))
        .expect("list")
        .map(|entry| entry.expect("entry").file_name())
        .collect();
    assert_eq!(names, ["config.json"]);
    let oversized = write(&"x".repeat(513 * KIB), None, json!({})).await;
    assert_eq!(code(oversized), "file_too_large");
}

#[tokio::test]
async fn writes_and_reads_chunks() {
    let (h, root) = files_harness();
    let r = root.to_str().expect("utf8");
    let chunk = |offset: u64, data: &[u8]| {
        let value = json!({ "path": "out.bin", "rootPath": r, "offset": offset, "dataBase64": STANDARD.encode(data) });
        write_file_chunk(&h.ctx, args(value))
    };
    assert_eq!(chunk(0, b"hello ").await.expect("first").size_bytes, 6);
    assert_eq!(chunk(6, b"world").await.expect("second").size_bytes, 11);
    assert_eq!(code(chunk(20, b"!").await), "conflict");
    assert_eq!(std::fs::read(root.join("out.bin")).expect("read"), b"hello world");
    let read = |revision: Value| {
        let value = json!({ "path": "out.bin", "rootPath": r, "offset": 6, "length": 100, "revision": revision });
        read_file_chunk(&h.ctx, args(value))
    };
    let first = read(Value::Null).await.expect("chunk");
    assert_eq!(STANDARD.decode(&first.data_base64).expect("base64"), b"world");
    let mime = first.mime_type.as_deref();
    assert_eq!((first.size_bytes, mime), (11, Some("application/octet-stream")));
    let same = read(json!(first.revision)).await.expect("same revision");
    assert_eq!(same.revision, first.revision);
    let error = read(json!("stale")).await.expect_err("stale");
    assert_eq!((error.code.as_str(), error.retryable), ("conflict", true));
    let bad = json!({ "path": "out.bin", "rootPath": r, "offset": 0, "length": 513 * KIB, "revision": null });
    let error = read_file_chunk(&h.ctx, args(bad)).await.expect_err("too long");
    assert_eq!(error.message, "A chunk is at most 524288 bytes");
    let fractional = json!({ "path": "out.bin", "rootPath": r, "offset": 1.5, "dataBase64": "" });
    let error = write_file_chunk(&h.ctx, args(fractional)).await.expect_err("fraction");
    assert_eq!(error.message, "offset must be a non-negative integer");
}

#[tokio::test]
async fn mutates_paths() {
    let (h, root) = files_harness();
    let r = root.to_str().expect("utf8");
    let mutate = |value: Value| mutate_path(&h.ctx, args(value));
    let made = mutate(json!({ "op": "mkdir", "path": "a/b", "rootPath": r, "recursive": true }));
    assert_eq!(
        serde_json::to_value(made.await.expect("mkdir")).expect("json"),
        json!({ "ok": true })
    );
    assert_eq!(
        code(mutate(json!({ "op": "mkdir", "path": "a", "rootPath": r })).await),
        "conflict"
    );
    let moved = json!({ "op": "move", "sourcePath": "notes.txt", "destinationPath": "a/b/n.txt", "rootPath": r });
    mutate(moved.clone()).await.expect("move");
    assert!(root.join("a/b/n.txt").is_file());
    let back = json!({ "op": "move", "sourcePath": "a/b/n.txt", "destinationPath": "link", "rootPath": r });
    let error = mutate(back).await.expect_err("exists");
    assert_eq!(error.message, "Destination already exists: link");
    assert_eq!(
        code(mutate(json!({ "op": "remove", "path": "link", "rootPath": r })).await),
        "invalid_path"
    );
    assert_eq!(
        code(mutate(json!({ "op": "remove", "path": "a", "rootPath": r })).await),
        "invalid_path"
    );
    mutate(json!({ "op": "remove", "path": "a", "rootPath": r, "recursive": true }))
        .await
        .expect("rm");
    assert!(!root.join("a").exists());
}

#[test]
fn parses_frontmatter() {
    let text = "\u{feff}---\nname: x\ndescription: \"Quoted\"\nlong: >\n  folded\n  more\nargument-hint: '<file>'\n---\nbody: no\n";
    let fields = parse_frontmatter(text);
    assert_eq!(fields.get("description").map(String::as_str), Some("Quoted"));
    assert_eq!(fields.get("long").map(String::as_str), Some("folded more"));
    assert_eq!(fields.get("argument-hint").map(String::as_str), Some("<file>"));
    assert_eq!(fields.get("body"), None);
    let unterminated = parse_frontmatter("---\na: 1\nb: 2");
    assert_eq!(
        (unterminated.get("a").map(String::as_str), unterminated.get("b")),
        (Some("1"), None)
    );
}

#[tokio::test]
async fn lists_commands() {
    let h = Harness::new();
    let project = h.root.join("project");
    h.write(
        &project,
        &[
            (
                ".bb/skills/review/SKILL.md",
                b"---\ndescription: Review code\nargument-hint: <pr>\n---\n",
            ),
            (".bb/skills/loose.md", b"ignored"),
        ],
    );
    h.write(
        &h.ctx.data_dir,
        &[
            ("skills/review/SKILL.md", b"---\ndescription: User review\n---\n"),
            ("skills/Alpha/SKILL.md", b"no frontmatter"),
        ],
    );
    let cwd = project.to_str().expect("utf8");
    let echo = list_commands(&h.ctx, args(json!({ "providerId": "echo", "cwd": cwd })))
        .await
        .expect("echo");
    assert_eq!(
        serde_json::to_value(echo).expect("json"),
        json!({ "commands": [
            { "name": "Alpha", "source": "skill", "origin": "user", "description": null, "argumentHint": null },
            { "name": "review", "source": "skill", "origin": "project", "description": "Review code", "argumentHint": "<pr>" },
        ] })
    );
    let codex = list_commands(&h.ctx, args(json!({ "providerId": "codex", "cwd": null })))
        .await
        .expect("codex");
    let names: Vec<_> =
        codex.commands.iter().take(2).map(|command| command.name.as_str()).collect();
    assert_eq!(names, ["clear", "compact"]);
}

#[test]
fn helpers_match_node() {
    use bb_fs::read::{absolute_target, mime_type_of};
    use bb_fs::write::decode_base64_lenient;
    assert_eq!(mime_type_of("notes.txt").as_deref(), Some("text/plain"));
    assert_eq!(mime_type_of("json").as_deref(), Some("application/json"));
    assert_eq!(mime_type_of("Makefile"), None);
    assert_eq!(mime_type_of("dir.d/file"), None);
    assert_eq!(decode_base64_lenient("aGVsbG8"), b"hello");
    assert_eq!(decode_base64_lenient("aGVs\nbG8=ignored"), b"hello");
    assert_eq!(decode_base64_lenient("-_-_"), vec![0xfb, 0xff, 0xbf]);
    let error = absolute_target("a\0b", Some("/r")).expect_err("nul");
    assert_eq!(error.message, "Path must not contain NUL");
    let resolved = absolute_target("../x/./y", Some("/r/s/")).expect("resolve");
    assert_eq!(resolved, Path::new("/r/x/y"));
    let content = FileContent {
        path: "p".into(),
        content: String::new(),
        content_encoding: bb_fs::read::ContentEncoding::Utf8,
        mime_type: None,
        modified_at_ms: Some(1_700_000_000_000.0),
        sha256: String::new(),
        size_bytes: 0,
    };
    let text = serde_json::to_string(&content).expect("json");
    assert!(text.contains("\"modifiedAtMs\":1700000000000,"), "{text}");
}
