use std::collections::HashMap;
use std::future::Future;

use bb_core::env::EnvMap;
use bb_core::exec::{
    Ctx, GitOptions, Repo, normalize, open_repo, path_exists, require_absolute, require_branch_name,
};
use bb_core::{RunnerErrorCode, RunnerResult, fail};

use crate::parse::{
    CONFLICT_CODES, PorcelainEntry, name_status_kind, parse_name_status_z, parse_numstat_z,
    parse_porcelain_z, porcelain_kind, split_nul, sum_line_stats,
};
use crate::types::*;

const STATUS_TIMEOUT_MS: u64 = 15_000;
const STATUS_MAX_COMMITS: &str = "--max-count=200";
const UNTRACKED_STAT_MAX_FILES: usize = 50;
const UNTRACKED_STAT_MAX_BYTES: u64 = 8 * 1024 * 1024;
const OPERATION_MARKERS: [(&str, &str); 5] = [
    ("rebase", "rebase-merge"),
    ("rebase", "rebase-apply"),
    ("merge", "MERGE_HEAD"),
    ("cherry-pick", "CHERRY_PICK_HEAD"),
    ("revert", "REVERT_HEAD"),
];
#[cfg(windows)]
const DEV_NULL: &str = "\\\\.\\nul";
#[cfg(not(windows))]
const DEV_NULL: &str = "/dev/null";

fn status_options() -> GitOptions {
    GitOptions { timeout_ms: Some(STATUS_TIMEOUT_MS), ..GitOptions::default() }
}

fn not_a_repo(exists: bool) -> PathInspection {
    PathInspection {
        exists,
        is_git_repo: false,
        is_worktree: false,
        branch_name: None,
        default_branch: None,
        remote_url: None,
    }
}

fn not_a_source() -> GitSourceInspection {
    GitSourceInspection {
        checkout: GitCheckoutRef::Unknown { reason: "Path is not a git repository".to_owned() },
        default_branch: None,
        default_branch_relation: None,
        is_worktree: false,
        has_uncommitted_changes: false,
        operation: WorkspaceGitOperation::None,
        origin_default_branch: None,
    }
}

struct BranchRefs {
    local: Vec<String>,
    remote: Vec<String>,
    default_branch: Option<String>,
    origin_default_branch: Option<String>,
}

pub async fn repo_kind(repo: &Repo) -> RunnerResult<RepoKind> {
    let flags = ["rev-parse", "--is-inside-work-tree", "--is-bare-repository"];
    let shown = repo.line(&flags).await?.unwrap_or_default();
    let mut lines = shown.split('\n');
    let (inside, bare) = (lines.next(), lines.next());
    Ok(if inside == Some("true") {
        RepoKind::WorkTree
    } else if bare == Some("true") {
        RepoKind::Bare
    } else {
        RepoKind::None
    })
}

pub async fn require_repo(ctx: &Ctx, cwd: &str) -> RunnerResult<Repo> {
    let repo = open_repo(ctx, require_absolute(cwd, "Path")?);
    match repo.line(&["rev-parse", "--show-toplevel"]).await? {
        Some(top_level) => Ok(open_repo(ctx, top_level)),
        None => fail(RunnerErrorCode::NotGitRepo, format!("Path is not a git repository: {cwd}")),
    }
}

async fn probe(ctx: &Ctx, cwd: &str) -> RunnerResult<(Repo, RepoKind)> {
    let repo = open_repo(ctx, require_absolute(cwd, "Path")?).with(status_options());
    let is_dir = tokio::fs::metadata(cwd).await.is_ok_and(|meta| meta.is_dir());
    let kind = if is_dir { repo_kind(&repo).await? } else { RepoKind::None };
    Ok((repo, kind))
}

pub async fn revision(repo: &Repo, reference: &str) -> RunnerResult<Option<String>> {
    let target = format!("{reference}^{{commit}}");
    repo.line(&["rev-parse", "--verify", "--quiet", &target]).await
}

pub async fn current_branch(repo: &Repo) -> RunnerResult<Option<String>> {
    let reference = repo.line(&["symbolic-ref", "--quiet", "HEAD"]).await?;
    Ok(reference.and_then(|name| name.strip_prefix("refs/heads/").map(str::to_owned)))
}

pub async fn merge_base_ref(repo: &Repo, reference: &str) -> RunnerResult<Option<String>> {
    repo.line(&["merge-base", reference, "HEAD"]).await
}

pub async fn has_ref(repo: &Repo, reference: &str) -> RunnerResult<bool> {
    let shown = repo.attempt(&["show-ref", "--verify", "--quiet", reference]).await?;
    Ok(shown.exit_code == 0)
}

pub async fn checkout_ref(repo: &Repo) -> RunnerResult<GitCheckoutRef> {
    let (branch_name, head_sha) = tokio::try_join!(current_branch(repo), revision(repo, "HEAD"))?;
    Ok(match (branch_name, head_sha) {
        (Some(branch_name), None) => GitCheckoutRef::Unborn { branch_name: Some(branch_name) },
        (Some(branch_name), Some(sha)) => {
            GitCheckoutRef::Branch { branch_name, head_sha: Some(sha) }
        }
        (None, None) => GitCheckoutRef::Unknown {
            reason: "HEAD is not symbolic and no commit is checked out".to_owned(),
        },
        (None, Some(sha)) => GitCheckoutRef::Detached { head_sha: Some(sha) },
    })
}

pub async fn head_or_empty_tree(repo: &Repo) -> RunnerResult<String> {
    if revision(repo, "HEAD").await?.is_some() {
        return Ok("HEAD".to_owned());
    }
    let tree = repo.git(&["hash-object", "-t", "tree", DEV_NULL]).await?;
    Ok(tree.stdout.trim().to_owned())
}

pub async fn git_dirs(repo: &Repo) -> RunnerResult<GitDirs> {
    let shown = repo.git(&["rev-parse", "--absolute-git-dir", "--git-common-dir"]).await?;
    let mut lines = shown.stdout.trim().split('\n');
    let git_dir = lines.next().unwrap_or("");
    let common = lines.next().unwrap_or("");
    let process_cwd = std::env::current_dir().unwrap_or_default();
    Ok(GitDirs {
        git_dir: normalize(&process_cwd.join(&repo.cwd).join(git_dir)),
        common_dir: normalize(&process_cwd.join(&repo.cwd).join(common)),
    })
}

async fn is_linked_worktree(repo: &Repo) -> RunnerResult<bool> {
    let dirs = git_dirs(repo).await?;
    Ok(dirs.git_dir != dirs.common_dir)
}

async fn branch_names(repo: &Repo, namespace: &str) -> RunnerResult<Vec<String>> {
    let format = "--format=%(refname:lstrip=2)%09%(symref)";
    let shown = repo.git(&["for-each-ref", format, namespace]).await?;
    Ok(shown
        .stdout
        .split('\n')
        .filter_map(|line| {
            let mut parts = line.split('\t');
            let name = parts.next().unwrap_or("");
            let symref = parts.next().unwrap_or("");
            (!name.is_empty() && symref.is_empty()).then(|| name.to_owned())
        })
        .collect())
}

pub async fn local_branches(repo: &Repo) -> RunnerResult<Vec<String>> {
    branch_names(repo, "refs/heads").await
}

async fn origin_head(repo: &Repo) -> RunnerResult<Option<String>> {
    let prefix = "refs/remotes/origin/";
    let reference = repo.line(&["symbolic-ref", "--quiet", &format!("{prefix}HEAD")]).await?;
    Ok(reference.and_then(|name| name.strip_prefix(prefix).map(str::to_owned)))
}

fn preferred_local(local: &[String], origin: Option<&str>) -> Option<String> {
    [origin, Some("main"), Some("master")]
        .into_iter()
        .flatten()
        .find(|name| local.iter().any(|branch| branch == name))
        .map(str::to_owned)
        .or_else(|| local.first().cloned())
}

pub async fn default_branch(repo: &Repo) -> RunnerResult<Option<String>> {
    match origin_head(repo).await? {
        Some(head) => Ok(Some(head)),
        None => Ok(preferred_local(&local_branches(repo).await?, None)),
    }
}

async fn branch_refs(repo: &Repo, kind: RepoKind) -> RunnerResult<BranchRefs> {
    let (head, local, remote) = if kind == RepoKind::None {
        (None, Vec::new(), Vec::new())
    } else {
        tokio::try_join!(
            origin_head(repo),
            local_branches(repo),
            branch_names(repo, "refs/remotes")
        )?
    };
    let default_branch = preferred_local(&local, head.as_deref());
    let origin_default_branch = [head.as_ref(), default_branch.as_ref()]
        .into_iter()
        .flatten()
        .map(|name| format!("origin/{name}"))
        .find(|name| remote.contains(name));
    Ok(BranchRefs { local, remote, default_branch, origin_default_branch })
}

async fn default_branch_relation(
    repo: &Repo,
    refs: &BranchRefs,
) -> RunnerResult<Option<DefaultBranchRelation>> {
    let (Some(default_branch), Some(origin_default)) =
        (&refs.default_branch, &refs.origin_default_branch)
    else {
        return Ok(None);
    };
    let range = format!("refs/heads/{default_branch}...refs/remotes/{origin_default}");
    let counts = repo.line(&["rev-list", "--left-right", "--count", &range]).await?;
    let counts = counts.unwrap_or_default();
    let numbers: Vec<f64> =
        counts.split_whitespace().map(|part| part.parse().unwrap_or(f64::NAN)).collect();
    let [ahead, behind, ..] = numbers[..] else {
        return Ok(Some(DefaultBranchRelation::Unknown));
    };
    Ok(Some(match (ahead == 0.0, behind == 0.0) {
        (true, true) => DefaultBranchRelation::Equal,
        (true, false) => DefaultBranchRelation::LocalBehind,
        (false, true) => DefaultBranchRelation::LocalAhead,
        (false, false) => DefaultBranchRelation::Diverged,
    }))
}

pub async fn default_worktree_base(repo: &Repo) -> RunnerResult<Option<String>> {
    let refs = branch_refs(repo, RepoKind::WorkTree).await?;
    let relation = default_branch_relation(repo, &refs).await?;
    let up_to_date =
        matches!(relation, Some(DefaultBranchRelation::Equal | DefaultBranchRelation::LocalBehind));
    let prefer_origin = refs.default_branch.is_none() || up_to_date;
    Ok(match refs.origin_default_branch {
        Some(origin) if prefer_origin => Some(origin),
        _ => refs.default_branch,
    })
}

async fn porcelain(repo: &Repo, untracked: &str) -> RunnerResult<Vec<PorcelainEntry>> {
    let mode = format!("--untracked-files={untracked}");
    let shown = repo.git(&["status", "--porcelain=v1", "-z", &mode]).await?;
    Ok(parse_porcelain_z(&shown.stdout))
}

pub async fn is_dirty(repo: &Repo) -> RunnerResult<bool> {
    Ok(!porcelain(repo, "normal").await?.is_empty())
}

pub async fn git_operation(repo: &Repo) -> RunnerResult<WorkspaceGitOperation> {
    let dirs = git_dirs(repo).await?;
    for (kind, marker) in OPERATION_MARKERS {
        if path_exists(dirs.git_dir.join(marker)).await {
            let entries = porcelain(repo, "normal").await?;
            let has_conflicts = entries.iter().any(|entry| {
                entry.code.contains('U') || CONFLICT_CODES.contains(&entry.code.as_str())
            });
            return Ok(match kind {
                "rebase" => WorkspaceGitOperation::Rebase { has_conflicts },
                "merge" => WorkspaceGitOperation::Merge { has_conflicts },
                "cherry-pick" => WorkspaceGitOperation::CherryPick { has_conflicts },
                _ => WorkspaceGitOperation::Revert { has_conflicts },
            });
        }
    }
    Ok(WorkspaceGitOperation::None)
}

pub async fn inspect_path(ctx: &Ctx, args: PathArgs) -> RunnerResult<PathInspection> {
    let (repo, kind) = probe(ctx, &args.path).await?;
    if kind != RepoKind::WorkTree {
        return Ok(not_a_repo(path_exists(&args.path).await));
    }
    let (branch_name, fallback, is_worktree, remote_url) = tokio::try_join!(
        current_branch(&repo),
        default_branch(&repo),
        is_linked_worktree(&repo),
        repo.line(&["remote", "get-url", "origin"]),
    )?;
    Ok(PathInspection {
        exists: true,
        is_git_repo: true,
        is_worktree,
        default_branch: fallback.or_else(|| branch_name.clone()),
        branch_name,
        remote_url,
    })
}

pub async fn inspect_git_source(ctx: &Ctx, args: PathArgs) -> RunnerResult<GitSourceInspection> {
    let (repo, kind) = probe(ctx, &args.path).await?;
    if kind == RepoKind::None {
        return Ok(not_a_source());
    }
    let work_tree = kind == RepoKind::WorkTree;
    let refs = branch_refs(&repo, kind).await?;
    let (checkout, relation, dirty, operation, is_worktree) = tokio::try_join!(
        checkout_ref(&repo),
        default_branch_relation(&repo, &refs),
        async { if work_tree { is_dirty(&repo).await } else { Ok(false) } },
        async {
            if work_tree { git_operation(&repo).await } else { Ok(WorkspaceGitOperation::None) }
        },
        async { if work_tree { is_linked_worktree(&repo).await } else { Ok(false) } },
    )?;
    Ok(GitSourceInspection {
        checkout,
        default_branch: refs.default_branch,
        default_branch_relation: relation,
        is_worktree,
        has_uncommitted_changes: dirty,
        operation,
        origin_default_branch: refs.origin_default_branch,
    })
}

fn branch_page(
    branches: &[String],
    pinned: Option<&str>,
    query: &str,
    limit: usize,
) -> (Vec<String>, bool) {
    let mut matching: Vec<&String> =
        branches.iter().filter(|branch| branch.to_lowercase().contains(query)).collect();
    matching.sort_by_key(|name| Some(name.as_str()) != pinned);
    let truncated = matching.len() > limit;
    (matching.into_iter().take(limit).cloned().collect(), truncated)
}

pub async fn list_branches(ctx: &Ctx, args: ListBranchesArgs) -> RunnerResult<GitBranchOptions> {
    let (repo, kind) = probe(ctx, &args.path).await?;
    let refs = branch_refs(&repo, kind).await?;
    let query = args.query.as_deref().unwrap_or("").trim().to_lowercase();
    let (branches, branches_truncated) =
        branch_page(&refs.local, refs.default_branch.as_deref(), &query, args.limit);
    let (remote_branches, remote_branches_truncated) =
        branch_page(&refs.remote, refs.origin_default_branch.as_deref(), &query, args.limit);
    let selected_branch = args.selected_branch.filter(|name| !name.is_empty()).map(|name| {
        let kind = if refs.local.contains(&name) {
            GitBranchKind::Local
        } else if refs.remote.contains(&name) {
            GitBranchKind::Remote
        } else {
            GitBranchKind::Missing
        };
        GitBranchRefClassification { name, kind }
    });
    Ok(GitBranchOptions {
        branches,
        branches_truncated,
        remote_branches,
        remote_branches_truncated,
        selected_branch,
    })
}

/// Runs `work` against a temporary index holding the given untracked files as intent-to-add,
/// with the subset of `paths` that exist as files or symlinks.
pub async fn with_untracked_index<T, F, Fut>(
    repo: &Repo,
    paths: &[String],
    work: F,
) -> RunnerResult<T>
where
    F: FnOnce(Repo, Vec<String>) -> Fut,
    Fut: Future<Output = RunnerResult<T>>,
{
    let directory = tempfile::Builder::new().prefix("bb-index-").tempdir()?;
    let pathspec_file = directory.path().join("pathspec");
    let index_file = directory.path().join("index");
    let mut env = EnvMap::new();
    env.insert("GIT_INDEX_FILE".to_owned(), index_file.to_string_lossy().into_owned());
    let indexed = repo.with(GitOptions { env, ..GitOptions::default() });
    let mut present = Vec::new();
    for file in paths {
        let meta = tokio::fs::symlink_metadata(repo.cwd.join(file)).await;
        if meta.is_ok_and(|meta| meta.is_file() || meta.file_type().is_symlink()) {
            present.push(file.clone());
        }
    }
    let pathspecs: String = present.iter().map(|file| format!(":(literal){file}\0")).collect();
    tokio::fs::write(&pathspec_file, pathspecs).await?;
    indexed.git(&["read-tree", "--empty"]).await?;
    if !present.is_empty() {
        let source = format!("--pathspec-from-file={}", pathspec_file.to_string_lossy());
        let flags = ["add", "--sparse", "--intent-to-add", "--pathspec-file-nul", &source];
        indexed.git(&flags).await?;
    }
    let result = work(indexed, present).await;
    drop(directory);
    result
}

async fn untracked_line_stats(repo: &Repo, paths: &[String]) -> (Vec<NumstatEntry>, bool) {
    if paths.is_empty() || paths.len() > UNTRACKED_STAT_MAX_FILES {
        return (Vec::new(), paths.is_empty());
    }
    let mut total = 0;
    for file in paths {
        let meta = tokio::fs::symlink_metadata(repo.cwd.join(file)).await;
        total += meta.map_or(0, |meta| meta.len());
    }
    if total > UNTRACKED_STAT_MAX_BYTES {
        return (Vec::new(), false);
    }
    let stats = with_untracked_index(repo, paths, |index, indexed| async move {
        let numstat = index.git(&["diff", "--numstat", "-z"]).await?;
        Ok((parse_numstat_z(&numstat.stdout), indexed.len() == paths.len()))
    });
    stats.await.unwrap_or_else(|_| (Vec::new(), false))
}

fn with_line_stats(
    files: Vec<(String, WorkspaceFileStatusKind)>,
    numstat: &[NumstatEntry],
) -> Vec<WorkspaceFileStatus> {
    let by_path: HashMap<&str, &NumstatEntry> =
        numstat.iter().map(|entry| (entry.path.as_str(), entry)).collect();
    files
        .into_iter()
        .take(STATUS_MAX_FILES)
        .map(|(path, status)| {
            let entry = by_path.get(path.as_str());
            WorkspaceFileStatus {
                insertions: entry.and_then(|entry| entry.insertions),
                deletions: entry.and_then(|entry| entry.deletions),
                path,
                status,
            }
        })
        .collect()
}

async fn merge_base_status(
    repo: &Repo,
    merge_base_branch: &str,
) -> RunnerResult<WorkspaceMergeBase> {
    let range = format!("{}...HEAD", require_branch_name(merge_base_branch)?);
    let format = "--format=%H%x1f%h%x1f%s%x1f%an%x1f%at";
    let cherry = ["--cherry-pick", "--right-only", "--reverse"];
    let log_args = ["log", cherry[0], cherry[1], cherry[2], STATUS_MAX_COMMITS, format, &range];
    let count_args = ["rev-list", "--cherry-pick", "--left-right", "--count", &range];
    let name_status_args = ["diff", "--no-ext-diff", "--name-status", "-z", &range];
    let numstat_args = ["diff", "--no-ext-diff", "--numstat", "-z", &range];
    let (base_ref, counts, log, name_status, numstat) = tokio::try_join!(
        merge_base_ref(repo, merge_base_branch),
        repo.line(&count_args),
        repo.attempt(&log_args),
        repo.attempt(&name_status_args),
        repo.attempt(&numstat_args),
    )?;
    let counts = counts.unwrap_or_default();
    let mut sides = counts.split_whitespace().map(|side| side.parse::<i64>().unwrap_or(0));
    let behind_count = sides.next().unwrap_or(0);
    let ahead_count = sides.next().unwrap_or(0);
    let commits: Vec<WorkspaceCommitSummary> = split_nul(&log.stdout.replace('\n', "\0"))
        .into_iter()
        .map(|line| {
            let mut fields = line.split('\u{1f}').map(str::to_owned);
            let mut next = || fields.next().unwrap_or_default();
            let (sha, short_sha, subject, author_name) = (next(), next(), next(), next());
            let at = fields.next().unwrap_or_else(|| "0".to_owned());
            let authored_at = crate::parse::parse_count(&at).unwrap_or(0) * 1000;
            WorkspaceCommitSummary { sha, short_sha, subject, author_name, authored_at }
        })
        .collect();
    let has_commits = !commits.is_empty();
    let stats = if has_commits { parse_numstat_z(&numstat.stdout) } else { Vec::new() };
    let changed = if has_commits { parse_name_status_z(&name_status.stdout) } else { Vec::new() };
    let files: Vec<_> =
        changed.into_iter().map(|entry| (entry.path, name_status_kind(&entry.status))).collect();
    let file_count = files.len();
    let sums = sum_line_stats(&stats);
    Ok(WorkspaceMergeBase {
        merge_base_branch: merge_base_branch.to_owned(),
        base_ref,
        ahead_count,
        behind_count,
        has_committed_unmerged_changes: ahead_count > 0,
        commits,
        files: with_line_stats(files, &stats),
        insertions: sums.insertions,
        deletions: sums.deletions,
        line_stats_complete: numstat.exit_code == 0 && file_count <= STATUS_MAX_FILES,
    })
}

pub async fn git_status(ctx: &Ctx, args: GitStatusArgs) -> RunnerResult<WorkspaceStatus> {
    let base = require_repo(ctx, &args.path).await?;
    let repo = base.with(status_options());
    let head = head_or_empty_tree(&repo).await?;
    let merge_base_branch = args.merge_base_branch.filter(|name| !name.is_empty());
    let tracked_args = ["diff", "--numstat", "-z", &head, "--"];
    let (entries, tracked, checkout, fallback, merge_base) = tokio::try_join!(
        porcelain(&repo, "all"),
        repo.git(&tracked_args),
        checkout_ref(&repo),
        default_branch(&repo),
        async {
            match &merge_base_branch {
                Some(name) => merge_base_status(&repo, name).await.map(Some),
                None => Ok(None),
            }
        },
    )?;
    let untracked_paths: Vec<String> =
        entries.iter().filter(|entry| entry.code == "??").map(|entry| entry.path.clone()).collect();
    let (untracked_entries, untracked_complete) =
        untracked_line_stats(&repo, &untracked_paths).await;
    let mut stats = parse_numstat_z(&tracked.stdout);
    stats.extend(untracked_entries);
    let has_untracked = !untracked_paths.is_empty();
    let has_tracked = entries.len() > untracked_paths.len();
    let committed = merge_base.as_ref().is_some_and(|base| base.has_committed_unmerged_changes);
    let state = match (entries.is_empty(), committed, has_tracked) {
        (true, true, _) => WorkspaceState::CommittedUnmerged,
        (true, false, _) => WorkspaceState::Clean,
        (false, true, _) => WorkspaceState::DirtyAndCommittedUnmerged,
        (false, false, true) => WorkspaceState::DirtyUncommitted,
        (false, false, false) => WorkspaceState::Untracked,
    };
    let branch_name = match &checkout {
        GitCheckoutRef::Branch { branch_name, .. } => Some(branch_name.clone()),
        GitCheckoutRef::Unborn { branch_name } => branch_name.clone(),
        _ => None,
    };
    let line_stats_complete =
        entries.len() <= STATUS_MAX_FILES && (!has_untracked || untracked_complete);
    let has_uncommitted_changes = !entries.is_empty();
    let files: Vec<_> =
        entries.into_iter().map(|entry| (entry.path, porcelain_kind(&entry.code))).collect();
    let sums = sum_line_stats(&stats);
    Ok(WorkspaceStatus {
        working_tree: WorkspaceWorkingTree {
            has_uncommitted_changes,
            state,
            insertions: sums.insertions,
            deletions: sums.deletions,
            line_stats_complete,
            files: with_line_stats(files, &stats),
        },
        checkout,
        branch: WorkspaceBranch {
            default_branch: fallback.or_else(|| branch_name.clone()).unwrap_or_default(),
            current_branch: branch_name,
        },
        merge_base,
    })
}

pub async fn git_commit(ctx: &Ctx, args: GitCommitArgs) -> RunnerResult<GitCommitResult> {
    let repo = require_repo(ctx, &args.path).await?;
    let dirs = git_dirs(&repo).await?;
    let key = dirs.git_dir.to_string_lossy().into_owned();
    ctx.lock
        .run(&key, async {
            repo.git(&["add", "-A"]).await?;
            let staged = repo.attempt(&["diff", "--cached", "--quiet"]).await?;
            if staged.exit_code == 0 {
                return fail(RunnerErrorCode::NoChanges, "No changes to commit");
            }
            repo.git(&["commit", "-m", &args.message, "--no-verify"]).await?;
            let (commit_sha, subject) = tokio::try_join!(
                repo.git(&["rev-parse", "HEAD"]),
                repo.git(&["log", "-1", "--pretty=%s"]),
            )?;
            Ok(GitCommitResult {
                commit_sha: commit_sha.stdout.trim().to_owned(),
                commit_subject: subject.stdout.trim().to_owned(),
            })
        })
        .await
}
