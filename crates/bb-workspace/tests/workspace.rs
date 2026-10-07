use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use bb_core::env::{fixed_env, process_env, scrub_env};
use bb_core::exec::{Ctx, KeyedLock};
use bb_core::{RunnerErrorCode, RunnerEvent, RunnerEventBody};
use bb_workspace::diff::*;
use bb_workspace::list::*;
use bb_workspace::watch::*;
use bb_workspace::worktrees::*;
use parking_lot::Mutex;

struct Harness {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    ctx: Ctx,
    events: Arc<Mutex<Vec<RunnerEvent>>>,
}

impl Harness {
    fn new() -> Self {
        let tmp = tempfile::Builder::new().prefix("bb-runner-").tempdir().unwrap();
        let root = std::fs::canonicalize(tmp.path()).unwrap();
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
        let events: Arc<Mutex<Vec<RunnerEvent>>> = Arc::default();
        let sink_events = events.clone();
        let ctx = Ctx {
            data_dir: root.join("data"),
            sink: Arc::new(move |event| sink_events.lock().push(event)),
            env: fixed_env(env),
            lock: KeyedLock::new(),
        };
        Harness { _tmp: tmp, root, ctx, events }
    }

    fn git(&self, cwd: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.com")
            .env("GIT_COMMITTER_NAME", "Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.com")
            .output()
            .unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn write(&self, path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn repo(&self) -> PathBuf {
        let repo = self.root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        self.git(&repo, &["init", "-q", "-b", "main"]);
        self.write(&repo.join("README.md"), "hello\n");
        self.git(&repo, &["add", "."]);
        self.git(&repo, &["commit", "-qm", "init"]);
        repo
    }
}

fn s(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[tokio::test]
async fn diffs_the_branch_everything_since_the_merge_base_and_one_commit() {
    let h = Harness::new();
    let repo = h.repo();
    h.git(&repo, &["switch", "-qc", "feature"]);
    h.write(&repo.join("feature.txt"), "one\ntwo\n");
    h.git(&repo, &["add", "."]);
    h.git(&repo, &["commit", "-qm", "feature"]);
    let sha = h.git(&repo, &["rev-parse", "HEAD"]);
    h.write(&repo.join("README.md"), "hello\nworld\n");
    h.write(&repo.join("new.txt"), "fresh\n");
    let base = || "main".to_owned();

    let target = WorkspaceDiffTarget::BranchCommitted { merge_base_branch: base() };
    let branch = git_diff_files(&h.ctx, DiffScope { path: s(&repo), target }).await.unwrap();
    let paths: Vec<&str> = branch.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, ["feature.txt"]);
    assert_eq!(branch.shortstat, "1 file changed, 2 insertions(+)\n");
    assert!(branch.merge_base_ref.is_some());
    assert_eq!(branch.initial_patches.len(), 1);
    assert!(branch.initial_patches[0].patch.contains("+two"));

    let target = WorkspaceDiffTarget::All { merge_base_branch: base() };
    let all = git_diff_files(&h.ctx, DiffScope { path: s(&repo), target }).await.unwrap();
    let mut paths: Vec<(&str, DiffOrigin)> =
        all.files.iter().map(|f| (f.path.as_str(), f.origin)).collect();
    paths.sort_by_key(|(path, _)| *path);
    assert_eq!(
        paths,
        [
            ("README.md", DiffOrigin::Tracked),
            ("feature.txt", DiffOrigin::Tracked),
            ("new.txt", DiffOrigin::Untracked)
        ]
    );
    let new = all.files.iter().find(|f| f.path == "new.txt").unwrap();
    assert_eq!((new.change_kind, new.additions), (DiffChangeKind::Added, 1));

    let target = WorkspaceDiffTarget::Commit { sha: sha.clone() };
    let commit = git_diff_files(&h.ctx, DiffScope { path: s(&repo), target }).await.unwrap();
    assert_eq!(commit.files.len(), 1);
    assert_eq!(commit.files[0].path, "feature.txt");

    let target = WorkspaceDiffTarget::Uncommitted;
    let paths = vec!["new.txt".to_owned(), "README.md".to_owned()];
    let patches =
        git_diff_patch(&h.ctx, DiffPatchArgs { path: s(&repo), target, paths }).await.unwrap();
    assert!(patches.patches[0].patch.contains("+fresh"));
    assert!(patches.patches[1].patch.contains("+world"));

    let file =
        EnvironmentDiffFileQuery::Commit { sha, path: "../x".to_owned(), side: DiffFileSide::New };
    let error = git_diff_file(&h.ctx, DiffFileArgs { path: s(&repo), file }).await.unwrap_err();
    assert_eq!(error.code, RunnerErrorCode::InvalidPath);
    let json = serde_json::to_value(&branch.files[0]).unwrap();
    assert_eq!(json["loadMode"], "auto");
    assert_eq!(json["changeKind"], "added");
}

#[tokio::test]
async fn creates_reuses_and_removes_worktrees() {
    let h = Harness::new();
    let repo = h.repo();
    h.write(&repo.join(".gitignore"), ".env\n");
    h.write(&repo.join(".worktreeinclude"), "# comment\n.env\n");
    h.write(&repo.join(".env"), "SECRET=1\n");
    let args = || CreateWorktreeArgs {
        source_path: s(&repo),
        key: "thr_1".to_owned(),
        branch_name: "bb/one".to_owned(),
        base_branch: None,
    };
    let created = create_worktree(&h.ctx, args()).await.unwrap();
    assert_eq!(created.merge_base_branch, "main");
    assert_eq!(created.worktree_include, Some(WorktreeIncludeReport { copied: 1, skipped: 0 }));
    let path = PathBuf::from(&created.path);
    assert_eq!(path, h.ctx.data_dir.join("worktrees/thr_1/repo"));
    assert_eq!(std::fs::read_to_string(path.join(".env")).unwrap(), "SECRET=1\n");
    assert_eq!(h.git(&path, &["branch", "--show-current"]), "bb/one");

    let again = create_worktree(&h.ctx, args()).await.unwrap();
    assert_eq!(again.worktree_include, None);
    let other = CreateWorktreeArgs { branch_name: "bb/two".to_owned(), ..args() };
    let conflict = create_worktree(&h.ctx, other).await.unwrap_err();
    assert_eq!(conflict.code, RunnerErrorCode::Conflict);

    let refused = remove_worktree(&h.ctx, RemoveWorktreeArgs { path: s(&repo) }).await;
    assert_eq!(
        refused.unwrap_err().message,
        format!("Refusing to remove an unmanaged path: {}", s(&repo))
    );
    remove_worktree(&h.ctx, RemoveWorktreeArgs { path: created.path.clone() }).await.unwrap();
    assert!(!path.exists());
    assert!(!h.git(&repo, &["worktree", "list"]).contains("thr_1"));

    let personal =
        ensure_personal_workspace(&h.ctx, EnsurePersonalWorkspaceArgs { key: "me".into() })
            .await
            .unwrap();
    assert!(Path::new(&personal.path).is_dir());
    let bad = ensure_personal_workspace(&h.ctx, EnsurePersonalWorkspaceArgs { key: "../x".into() });
    assert_eq!(bad.await.unwrap_err().message, "key must be a single safe path segment");
}

#[tokio::test]
async fn switches_branches_and_refuses_when_dirty() {
    let h = Harness::new();
    let repo = h.repo();
    let args = |branch: &str, from: Option<&str>| SwitchBranchArgs {
        path: s(&repo),
        branch_name: branch.to_owned(),
        create_from: from.map(str::to_owned),
    };
    let missing = switch_branch(&h.ctx, args("nope", None)).await.unwrap_err();
    assert_eq!(missing.message, "Cannot checkout branch nope because it does not exist");
    switch_branch(&h.ctx, args("dev", Some("main"))).await.unwrap();
    assert_eq!(h.git(&repo, &["branch", "--show-current"]), "dev");
    h.write(&repo.join("README.md"), "dirty\n");
    let dirty = switch_branch(&h.ctx, args("main", None)).await.unwrap_err();
    assert_eq!(dirty.message, "Cannot checkout branch while the workspace has uncommitted changes");
}

#[tokio::test]
async fn lists_ranks_and_browses_paths() {
    let h = Harness::new();
    let repo = h.repo();
    h.write(&repo.join("src/app/main.rs"), "");
    h.write(&repo.join(".hidden/x.txt"), "");
    h.write(&repo.join("node_modules/pkg/index.js"), "");
    let args = |query: &str| ListPathsArgs {
        root_path: s(&repo),
        query: Some(query.to_owned()),
        limit: 10,
        include_files: true,
        include_directories: true,
        include_hidden: None,
        exclude_names: Some(vec!["node_modules".to_owned()]),
    };
    let all = list_paths(&h.ctx, args("")).await.unwrap();
    let paths: Vec<&str> = all.paths.iter().map(|p| p.path.as_str()).collect();
    assert_eq!(paths, ["README.md", "src", "src/app", "src/app/main.rs"]);
    let ranked = list_paths(&h.ctx, args("main")).await.unwrap();
    assert_eq!(ranked.paths[0].path, "src/app/main.rs");
    assert_eq!(ranked.paths[0].positions, [8, 9, 10, 11]);
    let missing = ListPathsArgs { root_path: s(&repo.join("gone")), ..args("") };
    assert!(list_paths(&h.ctx, missing).await.unwrap().paths.is_empty());

    let listing =
        browse_directory(&h.ctx, BrowseDirectoryArgs { path: Some(s(&repo)) }).await.unwrap();
    let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, ["src", "README.md"]);
    assert_eq!(listing.parent, Some(s(&h.root)));
    let file = BrowseDirectoryArgs { path: Some(s(&repo.join("README.md"))) };
    assert_eq!(
        browse_directory(&h.ctx, file).await.unwrap_err().code,
        RunnerErrorCode::InvalidPath
    );

    let exists = PathsExistArgs { paths: vec![s(&repo), s(&repo.join("README.md/x"))] };
    let result = paths_exist(&h.ctx, exists).await.unwrap();
    assert_eq!(result.existence.values().copied().collect::<Vec<_>>(), [true, false]);
}

#[tokio::test]
async fn a_file_change_in_a_watched_workspace_signals() {
    let h = Harness::new();
    let repo = h.repo();
    let watcher = create_watcher(&h.ctx);
    let args =
        SetWatchedPathsArgs { generation: 1.0, workspaces: vec![s(&repo)], directories: vec![] };
    watcher.set_watched_paths(args).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    h.write(&repo.join("README.md"), "changed\n");
    let mut seen = false;
    for _ in 0..50 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        seen = h.events.lock().iter().any(|event| {
            matches!(&event.body, RunnerEventBody::WorkspaceChanged { change, .. }
                if change == "status" || change == "files")
        });
        if seen {
            break;
        }
    }
    watcher.dispose().await.unwrap();
    assert!(seen);
}

fn workspace_changes(h: &Harness) -> usize {
    let events = h.events.lock();
    events
        .iter()
        .filter(|event| matches!(&event.body, RunnerEventBody::WorkspaceChanged { .. }))
        .count()
}

async fn changes_within(h: &Harness, wait: Duration) -> usize {
    let before = workspace_changes(h);
    tokio::time::sleep(wait).await;
    workspace_changes(h) - before
}

#[tokio::test]
async fn reading_a_watched_workspace_does_not_signal() {
    let h = Harness::new();
    let repo = h.repo();
    h.write(&repo.join("src/lib.rs"), "fn main() {}\n");
    let watcher = create_watcher(&h.ctx);
    let args =
        SetWatchedPathsArgs { generation: 1.0, workspaces: vec![s(&repo)], directories: vec![] };
    watcher.set_watched_paths(args).await.unwrap();
    changes_within(&h, Duration::from_millis(800)).await;
    for _ in 0..5 {
        std::fs::read(repo.join("README.md")).unwrap();
        std::fs::read(repo.join("src/lib.rs")).unwrap();
        assert!(std::fs::read_dir(&repo).unwrap().count() > 0);
        assert!(std::fs::read_dir(repo.join("src")).unwrap().count() > 0);
    }
    assert_eq!(changes_within(&h, Duration::from_millis(800)).await, 0);
    watcher.dispose().await.unwrap();
}

#[tokio::test]
async fn watches_new_directories_but_not_dependency_trees() {
    let h = Harness::new();
    let repo = h.repo();
    h.write(&repo.join("node_modules/pkg/index.js"), "1\n");
    std::os::unix::fs::symlink(&repo, repo.join("node_modules/pkg/self")).unwrap();
    let watcher = create_watcher(&h.ctx);
    let args =
        SetWatchedPathsArgs { generation: 1.0, workspaces: vec![s(&repo)], directories: vec![] };
    watcher.set_watched_paths(args).await.unwrap();
    changes_within(&h, Duration::from_millis(800)).await;

    h.write(&repo.join("node_modules/pkg/index.js"), "2\n");
    h.write(&repo.join("node_modules/pkg/nested/deep.js"), "3\n");
    assert_eq!(changes_within(&h, Duration::from_millis(800)).await, 0);

    std::fs::create_dir_all(repo.join("fresh/inner")).unwrap();
    assert!(changes_within(&h, Duration::from_millis(800)).await > 0);
    h.write(&repo.join("fresh/inner/file.txt"), "new\n");
    assert!(changes_within(&h, Duration::from_millis(800)).await > 0);
    watcher.dispose().await.unwrap();
}
