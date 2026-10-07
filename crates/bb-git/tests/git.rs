use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use bb_core::RunnerErrorCode;
use bb_core::env::{EnvMap, fixed_env, process_env, scrub_env};
use bb_core::exec::{Ctx, KeyedLock};
use bb_git::*;

struct Harness {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    ctx: Ctx,
    env: EnvMap,
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
        let ctx = Ctx {
            data_dir: root.join("data"),
            sink: Arc::new(|_| {}),
            env: fixed_env(env.clone()),
            lock: KeyedLock::new(),
        };
        Harness { _tmp: tmp, root, ctx, env }
    }

    fn git(&self, cwd: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env_clear()
            .envs(&self.env)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    fn write(&self, directory: &Path, files: &[(&str, &str)]) {
        for (file, content) in files {
            let target = directory.join(file);
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
            std::fs::write(target, content).unwrap();
        }
    }

    fn commit_all(&self, repo: &Path, message: &str) -> String {
        self.git(repo, &["add", "-A"]);
        self.git(repo, &["commit", "--quiet", "-m", message]);
        self.git(repo, &["rev-parse", "HEAD"])
    }

    fn init_repo(&self, name: &str, files: &[(&str, &str)]) -> PathBuf {
        let repo = self.root.join(name);
        self.write(&repo, files);
        self.git(&repo, &["init", "--quiet", "-b", "main"]);
        self.commit_all(&repo, "initial");
        repo
    }
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn by_path(files: &[WorkspaceFileStatus]) -> HashMap<&str, &WorkspaceFileStatus> {
    files.iter().map(|file| (file.path.as_str(), file)).collect()
}

#[tokio::test]
async fn reports_the_working_tree_merge_base_and_branches() {
    let h = Harness::new();
    let rename_me = "same\n".repeat(20);
    let repo = h.init_repo(
        "repo",
        &[
            ("tracked.txt", "one\ntwo\nthree\n"),
            ("rename-me.txt", &rename_me),
            (".gitignore", "ignored.log\n"),
        ],
    );
    let main_sha = h.git(&repo, &["rev-parse", "HEAD"]);
    h.git(&repo, &["switch", "--quiet", "-c", "feature"]);
    h.write(&repo, &[("committed.txt", "committed\n")]);
    let feature_sha = h.commit_all(&repo, "add committed file");
    h.write(&repo, &[("staged.txt", "staged\n")]);
    h.git(&repo, &["add", "staged.txt"]);
    h.git(&repo, &["mv", "rename-me.txt", "renamed.txt"]);
    h.write(
        &repo,
        &[
            ("tracked.txt", "one\nTWO\nthree\nfour\n"),
            ("new.txt", "fresh\nfile\n"),
            ("ignored.log", "noise\n"),
        ],
    );

    let args = GitStatusArgs { path: text(&repo), merge_base_branch: Some("main".into()) };
    let status = git_status(&h.ctx, args).await.unwrap();
    assert_eq!(status.working_tree.state, WorkspaceState::DirtyAndCommittedUnmerged);
    assert!(status.working_tree.line_stats_complete);
    let files = by_path(&status.working_tree.files);
    let tracked = files["tracked.txt"];
    assert_eq!(
        (tracked.status, tracked.insertions, tracked.deletions),
        (WorkspaceFileStatusKind::M, Some(2), Some(1))
    );
    assert_eq!(files["staged.txt"].status, WorkspaceFileStatusKind::A);
    assert_eq!(files["renamed.txt"].status, WorkspaceFileStatusKind::R);
    assert_eq!(files["new.txt"].status, WorkspaceFileStatusKind::Untracked);
    assert_eq!(files["new.txt"].insertions, Some(2));
    assert!(!files.contains_key("ignored.log"));
    assert_eq!(
        status.checkout,
        GitCheckoutRef::Branch {
            branch_name: "feature".into(),
            head_sha: Some(feature_sha.clone())
        }
    );
    let merge_base = status.merge_base.unwrap();
    assert_eq!(merge_base.base_ref, Some(main_sha));
    assert_eq!((merge_base.ahead_count, merge_base.behind_count), (1, 0));
    assert_eq!(merge_base.commits.len(), 1);
    assert_eq!(merge_base.commits[0].sha, feature_sha);
    assert_eq!(merge_base.commits[0].subject, "add committed file");
    assert_eq!(merge_base.files.len(), 1);
    let committed = &merge_base.files[0];
    assert_eq!(
        (committed.path.as_str(), committed.status, committed.insertions),
        ("committed.txt", WorkspaceFileStatusKind::A, Some(1))
    );

    let first = ListBranchesArgs {
        path: text(&repo),
        query: None,
        selected_branch: Some("gone".into()),
        limit: 1,
    };
    let branches = list_branches(&h.ctx, first).await.unwrap();
    assert_eq!(branches.branches, ["main"]);
    assert!(branches.branches_truncated);
    assert_eq!(
        branches.selected_branch,
        Some(GitBranchRefClassification { name: "gone".into(), kind: GitBranchKind::Missing })
    );
}

#[tokio::test]
async fn inspects_paths_sources_and_commits() {
    let h = Harness::new();
    let repo = h.init_repo("repo", &[("a.txt", "a\n")]);
    let path = text(&repo);

    let inspection = inspect_path(&h.ctx, PathArgs { path: path.clone() }).await.unwrap();
    let json = serde_json::to_value(&inspection).unwrap();
    let expected = serde_json::json!({
        "exists": true, "isGitRepo": true, "isWorktree": false,
        "branchName": "main", "defaultBranch": "main", "remoteUrl": null,
    });
    assert_eq!(json, expected);
    let missing = text(&h.root.join("nope"));
    let gone = inspect_path(&h.ctx, PathArgs { path: missing.clone() }).await.unwrap();
    assert!(!gone.exists && !gone.is_git_repo);
    let relative = inspect_path(&h.ctx, PathArgs { path: "relative".into() }).await;
    assert_eq!(relative.unwrap_err().message, "Path must be an absolute path");

    let source = inspect_git_source(&h.ctx, PathArgs { path: path.clone() }).await.unwrap();
    assert!(!source.has_uncommitted_changes);
    assert_eq!(source.operation, WorkspaceGitOperation::None);
    assert_eq!(source.default_branch.as_deref(), Some("main"));
    let none = inspect_git_source(&h.ctx, PathArgs { path: missing }).await.unwrap();
    let none = serde_json::to_value(none).unwrap();
    assert_eq!(
        none["checkout"],
        serde_json::json!({"kind": "unknown", "reason": "Path is not a git repository"})
    );
    assert_eq!(none["operation"], serde_json::json!({"kind": "none"}));

    let commit = GitCommitArgs { path: path.clone(), message: "nothing".into() };
    let error = git_commit(&h.ctx, commit).await.unwrap_err();
    assert_eq!(
        (error.code, error.message.as_str()),
        (RunnerErrorCode::NoChanges, "No changes to commit")
    );
    h.write(&repo, &[("b.txt", "b\n")]);
    let dirty = inspect_git_source(&h.ctx, PathArgs { path: path.clone() }).await.unwrap();
    assert!(dirty.has_uncommitted_changes);
    let commit = GitCommitArgs { path: path.clone(), message: "add b\n\nbody".into() };
    let made = git_commit(&h.ctx, commit).await.unwrap();
    assert_eq!(made.commit_subject, "add b");
    assert_eq!(made.commit_sha, h.git(&repo, &["rev-parse", "HEAD"]));

    let plain = h.root.join("plain");
    std::fs::create_dir_all(&plain).unwrap();
    let args = GitStatusArgs { path: text(&plain), merge_base_branch: None };
    let error = git_status(&h.ctx, args).await.unwrap_err();
    assert_eq!(error.code, RunnerErrorCode::NotGitRepo);
}

#[tokio::test]
async fn reports_unborn_branches_and_linked_worktrees() {
    let h = Harness::new();
    let empty = h.root.join("empty");
    std::fs::create_dir_all(&empty).unwrap();
    h.git(&empty, &["init", "--quiet", "-b", "trunk"]);
    h.write(&empty, &[("x.txt", "x\n")]);
    let args = GitStatusArgs { path: text(&empty), merge_base_branch: None };
    let status = git_status(&h.ctx, args).await.unwrap();
    assert_eq!(status.checkout, GitCheckoutRef::Unborn { branch_name: Some("trunk".into()) });
    assert_eq!(status.working_tree.state, WorkspaceState::Untracked);
    assert_eq!(status.branch.default_branch, "trunk");
    let json = serde_json::to_value(&status).unwrap();
    let keys: Vec<_> = json["workingTree"].as_object().unwrap().keys().cloned().collect();
    let expected =
        ["hasUncommittedChanges", "state", "insertions", "deletions", "lineStatsComplete", "files"];
    assert_eq!(keys, expected);
    assert_eq!(json["workingTree"]["files"][0]["status"], "??");

    let repo = h.init_repo("repo", &[("a.txt", "a\n")]);
    let linked = h.root.join("linked");
    h.git(&repo, &["worktree", "add", "--quiet", "-b", "side", &text(&linked)]);
    let inspection = inspect_path(&h.ctx, PathArgs { path: text(&linked) }).await.unwrap();
    assert!(inspection.is_worktree);
    assert_eq!(inspection.branch_name.as_deref(), Some("side"));
    let ctx_repo = require_repo(&h.ctx, &text(&linked)).await.unwrap();
    assert_eq!(default_worktree_base(&ctx_repo).await.unwrap().as_deref(), Some("main"));
    assert!(has_ref(&ctx_repo, "refs/heads/side").await.unwrap());
    assert_eq!(repo_kind(&ctx_repo).await.unwrap(), RepoKind::WorkTree);
}
