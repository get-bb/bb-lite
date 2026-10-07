use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use bb_core::exec::{
    Ctx, GitOptions, Repo, is_inside, normalize, open_repo, path_exists, require_absolute,
    require_branch_name,
};
use bb_core::{RunnerError, RunnerErrorCode, RunnerResult, fail};
use bb_git::{GitCheckoutRef, RepoKind, WorkspaceGitOperation};
use serde::{Deserialize, Serialize};

const WORKTREES_DIR: &str = "worktrees";
const WORKSPACES_DIR: &str = "workspaces";
const INCLUDE_FILE_NAME: &str = ".worktreeinclude";
const BASE_FETCH_TIMEOUT_MS: u64 = 60_000;
const KILL_GRACE_MS: u64 = 2_000;
const KILL_ROUNDS: usize = 5;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorktreeArgs {
    pub source_path: String,
    pub key: String,
    pub branch_name: String,
    pub base_branch: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorktreeIncludeReport {
    pub copied: u32,
    pub skipped: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeResult {
    pub path: String,
    pub branch_name: String,
    pub merge_base_branch: String,
    pub worktree_include: Option<WorktreeIncludeReport>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct RemoveWorktreeArgs {
    pub path: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct EnsurePersonalWorkspaceArgs {
    pub key: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersonalWorkspace {
    pub path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchBranchArgs {
    pub path: String,
    pub branch_name: String,
    pub create_from: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchBranchResult {
    pub branch_name: String,
}

fn is_safe_segment(value: &str) -> bool {
    let mut chars = value.chars();
    chars.next().is_some_and(|first| first.is_ascii_alphanumeric() || first == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn require_segment<'a>(value: &'a str, label: &str) -> RunnerResult<&'a str> {
    if is_safe_segment(value) {
        Ok(value)
    } else {
        fail(RunnerErrorCode::InvalidPath, format!("{label} must be a single safe path segment"))
    }
}

fn repo_dir_name(source_path: &Path) -> String {
    let base = source_path.file_name().map(|name| name.to_string_lossy()).unwrap_or_default();
    let name = base.strip_suffix(".git").unwrap_or(&base);
    if is_safe_segment(name) && !name.ends_with('.') && name.chars().count() <= 200 {
        return name.to_owned();
    }
    format!("repo-{}", &bb_fs::read::sha256_hex(name)[..16])
}

async fn real_or_resolved(target: &Path) -> PathBuf {
    tokio::fs::canonicalize(target).await.unwrap_or_else(|_| normalize(target))
}

async fn is_strictly_inside(root: &Path, target: &Path) -> bool {
    let real_root = real_or_resolved(root).await;
    let real_target = real_or_resolved(target).await;
    real_root != real_target && is_inside(&real_root, &real_target)
}

async fn process_cwds() -> Vec<(i32, PathBuf)> {
    if cfg!(target_os = "linux") {
        let Ok(mut entries) = tokio::fs::read_dir("/proc").await else { return Vec::new() };
        let mut found = Vec::new();
        while let Ok(Some(entry)) = entries.next_entry().await {
            let Some(pid) = entry.file_name().to_str().and_then(|name| name.parse::<i32>().ok())
            else {
                continue;
            };
            if pid == 0 {
                continue;
            }
            let cwd = tokio::fs::read_link(format!("/proc/{pid}/cwd")).await.unwrap_or_default();
            found.push((pid, cwd));
        }
        return found;
    }
    if !cfg!(target_os = "macos") {
        return Vec::new();
    }
    let output = tokio::process::Command::new("lsof")
        .args(["-a", "-d", "cwd", "-F", "pn", "-w", "-n"])
        .kill_on_drop(true)
        .output()
        .await;
    let Ok(output) = output else { return Vec::new() };
    let listing = String::from_utf8_lossy(&output.stdout);
    let mut found = Vec::new();
    let mut pid = None;
    for line in listing.lines() {
        if let Some(value) = line.strip_prefix('p') {
            pid = value.parse::<i32>().ok();
        } else if let (Some(value), Some(current)) = (line.strip_prefix('n'), pid.take()) {
            found.push((current, PathBuf::from(value)));
        }
    }
    found
}

fn signal_all(pids: &[i32], signal: i32) -> Vec<i32> {
    pids.iter().copied().filter(|pid| unsafe { libc::kill(*pid, signal) } == 0).collect()
}

async fn kill_processes_with_cwd_under(directory: &Path) {
    let root = real_or_resolved(directory).await;
    let own = std::process::id() as i32;
    let inside = || async {
        process_cwds()
            .await
            .into_iter()
            .filter(|(pid, cwd)| {
                *pid != own && !cwd.as_os_str().is_empty() && is_inside(&root, cwd)
            })
            .map(|(pid, _)| pid)
            .collect::<Vec<_>>()
    };
    for _ in 0..KILL_ROUNDS {
        let targets = inside().await;
        if targets.is_empty() {
            return;
        }
        signal_all(&targets, libc::SIGTERM);
        let deadline = Instant::now() + Duration::from_millis(KILL_GRACE_MS);
        while Instant::now() < deadline && !signal_all(&targets, 0).is_empty() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        signal_all(&inside().await, libc::SIGKILL);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn completed_marker(target: &Path) -> PathBuf {
    let mut marker = target.as_os_str().to_owned();
    marker.push(".completed");
    PathBuf::from(marker)
}

async fn remove_managed_path(ctx: &Ctx, target: &Path) -> RunnerResult<()> {
    let parent = target.parent().unwrap_or(target).to_owned();
    remove_file_force(&completed_marker(target)).await?;
    if path_exists(target).await {
        kill_processes_with_cwd_under(target).await;
        let repo = open_repo(ctx, target);
        if let Some(relative) = repo.line(&["rev-parse", "--git-common-dir"]).await? {
            let common_dir = normalize(&target.join(relative));
            let common_text = common_dir.to_string_lossy().into_owned();
            let target_text = target.to_string_lossy().into_owned();
            let parent_repo = open_repo(ctx, &parent);
            let flags = ["--git-dir", &common_text, "worktree", "remove", &target_text, "--force"];
            ctx.lock.run(&common_text, parent_repo.attempt(&flags)).await?;
        }
        match tokio::fs::remove_dir_all(target).await {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                if tokio::fs::symlink_metadata(target).await.is_ok_and(|meta| !meta.is_dir()) {
                    remove_file_force(target).await?;
                } else {
                    return Err(error.into());
                }
            }
            _ => {}
        }
    }
    let _ = tokio::fs::remove_dir(&parent).await;
    Ok(())
}

async fn remove_file_force(target: &Path) -> RunnerResult<()> {
    match tokio::fs::remove_file(target).await {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
        _ => Ok(()),
    }
}

pub async fn remove_worktree(ctx: &Ctx, args: RemoveWorktreeArgs) -> RunnerResult<()> {
    let target = normalize(Path::new(require_absolute(&args.path, "Path")?));
    let mut managed = false;
    for name in [WORKTREES_DIR, WORKSPACES_DIR] {
        managed |= is_strictly_inside(&ctx.data_dir.join(name), &target).await;
    }
    if !managed {
        return fail(
            RunnerErrorCode::InvalidPath,
            format!("Refusing to remove an unmanaged path: {}", args.path),
        );
    }
    remove_managed_path(ctx, &target).await
}

pub async fn ensure_personal_workspace(
    ctx: &Ctx,
    args: EnsurePersonalWorkspaceArgs,
) -> RunnerResult<PersonalWorkspace> {
    let key = require_segment(&args.key, "key")?;
    let target = ctx.data_dir.join(WORKSPACES_DIR).join(key);
    tokio::fs::create_dir_all(&target).await?;
    Ok(PersonalWorkspace { path: target.to_string_lossy().into_owned() })
}

fn has_pattern(text: &str) -> bool {
    text.lines().any(|line| line.trim_start().chars().next().is_some_and(|first| first != '#'))
}

async fn copy_included_files(
    source: &Repo,
    target_path: &Path,
) -> RunnerResult<Option<WorktreeIncludeReport>> {
    let patterns =
        tokio::fs::read_to_string(source.cwd.join(INCLUDE_FILE_NAME)).await.unwrap_or_default();
    if !has_pattern(&patterns) {
        return Ok(None);
    }
    let exclude = format!("--exclude-from={INCLUDE_FILE_NAME}");
    let matches = match source.git(&["ls-files", "--others", "--ignored", &exclude, "-z"]).await {
        Ok(result) => bb_git::split_nul(&result.stdout),
        Err(_) => Vec::new(),
    };
    let real_target = tokio::fs::canonicalize(target_path).await?;
    let mut report = WorktreeIncludeReport::default();
    for relative in matches {
        let from = source.cwd.join(&relative);
        let to = real_target.join(&relative);
        if copy_one(&from, &to, &real_target).await.unwrap_or(false) {
            report.copied += 1;
        } else {
            report.skipped += 1;
        }
    }
    Ok(Some(report))
}

async fn copy_one(from: &Path, to: &Path, real_target: &Path) -> std::io::Result<bool> {
    if tokio::fs::symlink_metadata(from).await?.file_type().is_symlink() || path_exists(to).await {
        return Ok(false);
    }
    let parent = to.parent().unwrap_or(real_target);
    tokio::fs::create_dir_all(parent).await?;
    if !is_inside(real_target, &tokio::fs::canonicalize(parent).await?) {
        return Ok(false);
    }
    let (from, to) = (from.to_owned(), to.to_owned());
    tokio::task::spawn_blocking(move || {
        let mut input = std::fs::File::open(&from)?;
        let mut output = std::fs::OpenOptions::new().write(true).create_new(true).open(&to)?;
        std::io::copy(&mut input, &mut output)?;
        output.set_permissions(std::fs::metadata(&from)?.permissions())?;
        Ok(true)
    })
    .await
    .map_err(std::io::Error::other)?
}

async fn worktree_holding_branch(source: &Repo, branch_name: &str) -> RunnerResult<Option<String>> {
    let list = source.git(&["worktree", "list", "--porcelain", "-z"]).await?;
    let fields = bb_git::split_nul(&list.stdout);
    let wanted = format!("branch refs/heads/{branch_name}");
    let branch_index = fields.iter().position(|field| *field == wanted).unwrap_or(0);
    Ok(fields[..branch_index]
        .iter()
        .rev()
        .find_map(|field| field.strip_prefix("worktree "))
        .map(str::to_owned))
}

async fn fetch_remote_base(source: &Repo, base_branch: &str) -> RunnerResult<()> {
    let remotes = source.git(&["remote"]).await?.stdout;
    let remote = remotes
        .split('\n')
        .filter(|name| !name.is_empty() && base_branch.starts_with(&format!("{name}/")))
        .max_by_key(|name| name.len());
    let Some(remote) = remote else { return Ok(()) };
    let branch = &base_branch[remote.len() + 1..];
    let remote_ref = format!("refs/remotes/{remote}/{branch}");
    let mut options = GitOptions { timeout_ms: Some(BASE_FETCH_TIMEOUT_MS), ..Default::default() };
    options.env.insert("GIT_TERMINAL_PROMPT".into(), "0".into());
    options.env.insert("LC_ALL".into(), "C".into());
    let refspec = format!("+refs/heads/{branch}:{remote_ref}");
    let fetched = source.with(options).git(&["fetch", "--quiet", remote, &refspec]).await;
    match fetched {
        Err(error) if !bb_git::has_ref(source, &remote_ref).await? => Err(error),
        _ => Ok(()),
    }
}

pub async fn create_worktree(ctx: &Ctx, args: CreateWorktreeArgs) -> RunnerResult<WorktreeResult> {
    let source = open_repo(ctx, require_absolute(&args.source_path, "sourcePath")?);
    let branch_name = require_branch_name(&args.branch_name)?.to_owned();
    let root = ctx.data_dir.join(WORKTREES_DIR);
    let key = require_segment(&args.key, "key")?;
    let target = root.join(key).join(repo_dir_name(&source.cwd));
    let lock_key = format!("worktree:{}", target.display());
    ctx.lock
        .run(&lock_key, create_locked(ctx, &source, &root, &target, branch_name, args.base_branch))
        .await
}

async fn create_locked(
    ctx: &Ctx,
    source: &Repo,
    root: &Path,
    target: &Path,
    branch_name: String,
    base_branch: Option<String>,
) -> RunnerResult<WorktreeResult> {
    let marker = completed_marker(target);
    let target_text = target.to_string_lossy().into_owned();
    let completed = tokio::fs::read_to_string(&marker).await.unwrap_or_default();
    let mut lines = completed.split('\n');
    let completed_branch = lines.next().unwrap_or("");
    let merge_base_branch = lines.next().unwrap_or("");
    if !completed_branch.is_empty() && path_exists(target).await {
        if completed_branch == branch_name && !merge_base_branch.is_empty() {
            return Ok(WorktreeResult {
                path: target_text,
                branch_name,
                merge_base_branch: merge_base_branch.to_owned(),
                worktree_include: None,
            });
        }
        return fail(
            RunnerErrorCode::Conflict,
            format!("{target_text} already holds {completed_branch}"),
        );
    }
    remove_managed_path(ctx, target).await?;
    let source_text = source.cwd.display().to_string();
    if bb_git::repo_kind(source).await? == RepoKind::None {
        return fail(
            RunnerErrorCode::NotGitRepo,
            format!(
                "Cannot create a worktree because the source is not a Git repository: {source_text}. Initialize it and create at least one commit, then try again."
            ),
        );
    }
    if bb_git::revision(source, "HEAD").await?.is_none() {
        return fail(
            RunnerErrorCode::Failed,
            format!(
                "Cannot create a worktree because the repository has no commits: {source_text}. Create an initial commit, then try again."
            ),
        );
    }
    let base_branch = match base_branch {
        None => bb_git::default_worktree_base(source).await?,
        Some(base) => Some(require_branch_name(&base)?.to_owned()),
    };
    let Some(base_branch) = base_branch else {
        return fail(
            RunnerErrorCode::Failed,
            format!("Cannot resolve default branch for {source_text}"),
        );
    };
    let common_dir = bb_git::git_dirs(source).await?.common_dir.to_string_lossy().into_owned();
    ctx.lock.run(&common_dir, source.git(&["worktree", "prune"])).await?;
    if let Some(holder) = worktree_holding_branch(source, &branch_name).await?
        && is_strictly_inside(root, Path::new(&holder)).await
    {
        if bb_git::is_dirty(&open_repo(ctx, &holder)).await? {
            return fail(
                RunnerErrorCode::Conflict,
                format!(
                    "Branch {branch_name} is still checked out at {holder} by an earlier attempt, and that worktree has uncommitted changes, so it was left alone. Remove it to retry."
                ),
            );
        }
        remove_managed_path(ctx, Path::new(&holder)).await?;
    }
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let branch_exists = bb_git::has_ref(source, &format!("refs/heads/{branch_name}")).await?;
    if !branch_exists {
        fetch_remote_base(source, &base_branch).await?;
    }
    let added: Vec<&str> = if branch_exists {
        vec!["worktree", "add", &target_text, &branch_name]
    } else {
        vec!["worktree", "add", "-B", &branch_name, &target_text, &base_branch]
    };
    let attempt = async {
        ctx.lock.run(&common_dir, source.git(&added)).await?;
        let worktree_include = copy_included_files(source, target).await?;
        tokio::fs::write(&marker, format!("{branch_name}\n{base_branch}\n")).await?;
        Ok::<_, RunnerError>(worktree_include)
    };
    match attempt.await {
        Ok(worktree_include) => Ok(WorktreeResult {
            path: target_text.clone(),
            branch_name: branch_name.clone(),
            merge_base_branch: base_branch.clone(),
            worktree_include,
        }),
        Err(error) => {
            remove_managed_path(ctx, target).await?;
            Err(error)
        }
    }
}

fn refuse<T>(reason: impl std::fmt::Display) -> RunnerResult<T> {
    fail(RunnerErrorCode::Conflict, format!("Cannot checkout branch {reason}"))
}

fn operation_kind(operation: &WorkspaceGitOperation) -> Option<(&'static str, bool)> {
    use WorkspaceGitOperation as Op;
    match operation {
        Op::None => None,
        Op::Merge { has_conflicts } => Some(("merge", *has_conflicts)),
        Op::Rebase { has_conflicts } => Some(("rebase", *has_conflicts)),
        Op::CherryPick { has_conflicts } => Some(("cherry-pick", *has_conflicts)),
        Op::Revert { has_conflicts } => Some(("revert", *has_conflicts)),
        Op::Unknown { has_conflicts, .. } => Some(("unknown", *has_conflicts)),
    }
}

pub async fn switch_branch(ctx: &Ctx, args: SwitchBranchArgs) -> RunnerResult<SwitchBranchResult> {
    let repo = bb_git::require_repo(ctx, &args.path).await?;
    let branch_name = require_branch_name(&args.branch_name)?.to_owned();
    let git_dir = bb_git::git_dirs(&repo).await?.git_dir.to_string_lossy().into_owned();
    ctx.lock
        .run(&git_dir, async {
            let current = match bb_git::checkout_ref(&repo).await? {
                GitCheckoutRef::Detached { .. } => {
                    return refuse("while the workspace is on a detached HEAD");
                }
                GitCheckoutRef::Unknown { reason } => {
                    return refuse(format!("because the checkout is unreadable: {reason}"));
                }
                GitCheckoutRef::Branch { branch_name, .. } => (Some(branch_name), false),
                GitCheckoutRef::Unborn { branch_name } => (branch_name, true),
            };
            if current.0.as_deref() == Some(branch_name.as_str()) {
                return Ok(SwitchBranchResult { branch_name });
            }
            if current.1 {
                return refuse("before the current branch has an initial commit");
            }
            let creating = args.create_from.is_some();
            if !creating && !bb_git::local_branches(&repo).await?.contains(&branch_name) {
                return refuse(format!("{branch_name} because it does not exist"));
            }
            if let Some((kind, conflicts)) = operation_kind(&bb_git::git_operation(&repo).await?) {
                let state = if conflicts { "has unresolved conflicts" } else { "is in progress" };
                return refuse(format!("while {kind} {state}"));
            }
            if bb_git::is_dirty(&repo).await? {
                return refuse("while the workspace has uncommitted changes");
            }
            match &args.create_from {
                None => repo.git(&["switch", &branch_name]).await?,
                Some(from) => {
                    let from = require_branch_name(from)?;
                    repo.git(&["switch", "-c", &branch_name, from]).await?
                }
            };
            Ok(SwitchBranchResult { branch_name })
        })
        .await
}
