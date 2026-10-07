use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::sync::Arc;

use bb_core::exec::{Ctx, GitOptions, GitResult, Repo, require_branch_name, require_safe_ref};
use bb_core::{RunnerErrorCode, RunnerResult, fail};
use bb_fs::{FileContent, ReadFileArgs, read_file};
use bb_git::{NameStatusEntry, NumstatEntry};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

pub const DIFF_MAX_FILES: usize = 500;
pub const DIFF_PATCH_MAX_PATHS: usize = 50;
pub const DIFF_PATCH_MAX_BYTES_PER_FILE: usize = 256 * 1024;
pub const DIFF_RESPONSE_MAX_BYTES: usize = 600 * 1024;

const LISTING_MAX_BYTES: usize = 4 * 1024 * 1024;
const ESCAPE_ALLOWANCE: f64 = 1.25;
const AUTO_LOAD_MAX_CHANGED_LINES: i64 = 500;
const TOO_LARGE_CHANGED_LINES: i64 = 20_000;
const INLINE_PATCH_MAX_FILES: usize = 10;
const PATCH_CONCURRENCY: usize = 6;
const DIFF: [&str; 2] = ["diff", "--no-ext-diff"];
const NAME_STATUS: [&str; 3] = ["--name-status", "-M", "-z"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WorkspaceDiffTarget {
    Uncommitted,
    BranchCommitted {
        #[serde(rename = "mergeBaseBranch")]
        merge_base_branch: String,
    },
    All {
        #[serde(rename = "mergeBaseBranch")]
        merge_base_branch: String,
    },
    Commit {
        sha: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffOrigin {
    Tracked,
    Untracked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffLoadMode {
    Auto,
    OnDemand,
    TooLarge,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFileEntry {
    pub path: String,
    pub previous_path: Option<String>,
    pub change_kind: DiffChangeKind,
    pub additions: i64,
    pub deletions: i64,
    pub binary: bool,
    pub origin: DiffOrigin,
    pub load_mode: DiffLoadMode,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffPatchEntry {
    pub path: String,
    pub patch: String,
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFiles {
    pub files: Vec<DiffFileEntry>,
    pub truncated: bool,
    pub shortstat: String,
    pub merge_base_ref: Option<String>,
    pub initial_patches: Vec<DiffPatchEntry>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct DiffScope {
    pub path: String,
    pub target: WorkspaceDiffTarget,
}

#[derive(Clone, Debug, Deserialize)]
pub struct DiffPatchArgs {
    pub path: String,
    pub target: WorkspaceDiffTarget,
    pub paths: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffPatches {
    pub patches: Vec<DiffPatchEntry>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffFileSide {
    Old,
    New,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "target", rename_all = "snake_case")]
pub enum EnvironmentDiffFileQuery {
    Uncommitted {
        path: String,
        side: DiffFileSide,
    },
    BranchCommitted {
        #[serde(rename = "mergeBaseRef")]
        merge_base_ref: String,
        path: String,
        side: DiffFileSide,
    },
    All {
        #[serde(rename = "mergeBaseRef")]
        merge_base_ref: String,
        path: String,
        side: DiffFileSide,
    },
    Commit {
        sha: String,
        path: String,
        side: DiffFileSide,
    },
}

impl EnvironmentDiffFileQuery {
    fn path(&self) -> &str {
        match self {
            Self::Uncommitted { path, .. }
            | Self::BranchCommitted { path, .. }
            | Self::All { path, .. }
            | Self::Commit { path, .. } => path,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct DiffFileArgs {
    pub path: String,
    pub file: EnvironmentDiffFileQuery,
}

struct DiffRange {
    args: Vec<String>,
    includes_untracked: bool,
    merge_base_ref: Option<String>,
}

fn bounded(max_bytes: usize) -> GitOptions {
    GitOptions { max_bytes: Some(max_bytes + 1), allow_truncated: true, ..GitOptions::default() }
}

fn strs(values: &[String]) -> Vec<&str> {
    values.iter().map(String::as_str).collect()
}

async fn resolve_range(
    repo: &Repo,
    target: &WorkspaceDiffTarget,
) -> RunnerResult<Option<DiffRange>> {
    let owned = |items: &[&str]| items.iter().map(|item| (*item).to_owned()).collect::<Vec<_>>();
    let (branch, all) = match target {
        WorkspaceDiffTarget::Uncommitted => {
            let mut args = owned(&DIFF);
            args.push(bb_git::head_or_empty_tree(repo).await?);
            return Ok(Some(DiffRange { args, includes_untracked: true, merge_base_ref: None }));
        }
        WorkspaceDiffTarget::Commit { sha } => {
            let sha = require_safe_ref(sha)?;
            let show = ["show", "--format=", "--diff-merges=first-parent", "--no-ext-diff", sha];
            let args = owned(&show);
            return Ok(Some(DiffRange { args, includes_untracked: false, merge_base_ref: None }));
        }
        WorkspaceDiffTarget::BranchCommitted { merge_base_branch } => (merge_base_branch, false),
        WorkspaceDiffTarget::All { merge_base_branch } => (merge_base_branch, true),
    };
    let branch = require_branch_name(branch)?;
    let Some(base) = bb_git::merge_base_ref(repo, branch).await? else {
        return Ok(None);
    };
    let mut args = owned(&DIFF);
    args.push(if all { base.clone() } else { format!("{base}..HEAD") });
    Ok(Some(DiffRange { args, includes_untracked: all, merge_base_ref: Some(base) }))
}

fn literal(paths: &[String]) -> Vec<String> {
    paths.iter().map(|value| format!(":(literal){value}")).collect()
}

fn range_args(range: &DiffRange, flags: &[&str], paths: &[String]) -> Vec<String> {
    let mut args = range.args.clone();
    args.extend(flags.iter().map(|flag| (*flag).to_owned()));
    args.push("--".to_owned());
    args.extend(literal(paths));
    args
}

fn complete_records(result: &GitResult) -> &str {
    if !result.truncated {
        return &result.stdout;
    }
    match result.stdout.rfind('\0') {
        Some(index) => &result.stdout[..=index],
        None => "",
    }
}

fn truncate_utf8(value: &str, max_bytes: usize) -> (String, bool) {
    let bytes = value.as_bytes();
    let encoded = serde_json::to_string(value).map(|text| text.len()).unwrap_or(bytes.len());
    let inflation = encoded as f64 / bytes.len().max(1) as f64 / ESCAPE_ALLOWANCE;
    let mut cut = (max_bytes as f64 / inflation.max(1.0)).floor() as usize;
    if bytes.len() <= cut {
        return (value.to_owned(), false);
    }
    while cut > 0 && !value.is_char_boundary(cut) {
        cut -= 1;
    }
    (value[..cut].to_owned(), true)
}

fn shortstat(files: &[DiffFileEntry]) -> String {
    if files.is_empty() {
        return String::new();
    }
    let count = |total: i64, noun: &str, suffix: &str| {
        (total > 0).then(|| format!("{total} {noun}{}{suffix}", if total == 1 { "" } else { "s" }))
    };
    let additions = files.iter().map(|file| file.additions).sum();
    let deletions = files.iter().map(|file| file.deletions).sum();
    let parts: Vec<String> = [
        count(files.len() as i64, "file", " changed"),
        count(additions, "insertion", "(+)"),
        count(deletions, "deletion", "(-)"),
    ]
    .into_iter()
    .flatten()
    .collect();
    format!("{}\n", parts.join(", "))
}

fn to_file_entry(
    entry: &NameStatusEntry,
    stat: Option<&NumstatEntry>,
    origin: DiffOrigin,
) -> DiffFileEntry {
    let binary = stat.is_some_and(|stat| stat.insertions.is_none() && stat.deletions.is_none());
    let additions = stat.and_then(|stat| stat.insertions).unwrap_or(0);
    let deletions = stat.and_then(|stat| stat.deletions).unwrap_or(0);
    let changed_lines = additions + deletions;
    let deferred = binary || changed_lines > AUTO_LOAD_MAX_CHANGED_LINES;
    let change_kind = match entry.status.as_str() {
        "A" => DiffChangeKind::Added,
        "D" => DiffChangeKind::Deleted,
        "R" => DiffChangeKind::Renamed,
        "C" => DiffChangeKind::Copied,
        "T" => DiffChangeKind::TypeChanged,
        _ => DiffChangeKind::Modified,
    };
    DiffFileEntry {
        path: entry.path.clone(),
        previous_path: entry.previous_path.clone(),
        change_kind,
        additions,
        deletions,
        binary,
        origin,
        load_mode: if changed_lines > TOO_LARGE_CHANGED_LINES {
            DiffLoadMode::TooLarge
        } else if deferred {
            DiffLoadMode::OnDemand
        } else {
            DiffLoadMode::Auto
        },
    }
}

async fn list_untracked(repo: &Repo, paths: &[String]) -> RunnerResult<(Vec<String>, bool)> {
    let mut args = vec!["ls-files", "--others", "--exclude-standard", "-z", "--"];
    let literal = literal(paths);
    args.extend(strs(&literal));
    let result = repo.with(bounded(LISTING_MAX_BYTES)).git(&args).await?;
    Ok((bb_git::split_nul(complete_records(&result)), result.truncated))
}

fn stat_for<'a>(file: &str, among: &'a [NumstatEntry]) -> Option<&'a NumstatEntry> {
    among.iter().find(|entry| entry.path == file)
}

struct ChangedFiles {
    repo: Repo,
    range: Option<DiffRange>,
    files: Vec<DiffFileEntry>,
    truncated: bool,
}

async fn list_changed_files(ctx: &Ctx, args: &DiffScope) -> RunnerResult<ChangedFiles> {
    let repo = bb_git::require_repo(ctx, &args.path).await?;
    let range = resolve_range(&repo, &args.target).await?;
    let Some(range) = range else {
        return Ok(ChangedFiles { repo, range: None, files: Vec::new(), truncated: false });
    };
    let listed = repo.with(bounded(LISTING_MAX_BYTES));
    let names_args = range_args(&range, &NAME_STATUS, &[]);
    let numstat_args = range_args(&range, &["--numstat", "-M", "-z"], &[]);
    let (names_args, numstat_args) = (strs(&names_args), strs(&numstat_args));
    let (names, numstat) = tokio::try_join!(listed.git(&names_args), listed.git(&numstat_args))?;
    let stats = bb_git::parse_numstat_z(complete_records(&numstat));
    let tracked = bb_git::parse_name_status_z(complete_records(&names));
    let mut files: Vec<DiffFileEntry> = tracked
        .iter()
        .take(DIFF_MAX_FILES)
        .map(|entry| to_file_entry(entry, stat_for(&entry.path, &stats), DiffOrigin::Tracked))
        .collect();
    let mut truncated = names.truncated || tracked.len() > DIFF_MAX_FILES;
    if range.includes_untracked && !truncated {
        let (others, others_truncated) = list_untracked(&repo, &[]).await?;
        let room = DIFF_MAX_FILES - files.len();
        let untracked: Vec<String> = others.iter().take(room).cloned().collect();
        truncated = others_truncated || others.len() > room;
        if !untracked.is_empty() {
            let numstat_of = |index: Repo, _: Vec<String>| async move {
                index.git(&["diff", "--no-ext-diff", "--numstat", "-z"]).await
            };
            let added = bb_git::with_untracked_index(&repo, &untracked, numstat_of).await?;
            let untracked_stats = bb_git::parse_numstat_z(&added.stdout);
            for file in &untracked {
                let entry = NameStatusEntry {
                    path: file.clone(),
                    previous_path: None,
                    status: "A".to_owned(),
                };
                let stat = stat_for(file, &untracked_stats);
                files.push(to_file_entry(&entry, stat, DiffOrigin::Untracked));
            }
        }
    }
    Ok(ChangedFiles { repo, range: Some(range), files, truncated })
}

async fn map_limited<F, Fut>(items: Vec<String>, work: F) -> RunnerResult<()>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = RunnerResult<()>>,
{
    let queue = Mutex::new(std::collections::VecDeque::from(items));
    let worker = || async {
        loop {
            let next = queue.lock().pop_front();
            let Some(item) = next else { return Ok(()) };
            work(item).await?;
        }
    };
    let workers: Vec<_> = (0..PATCH_CONCURRENCY).map(|_| worker()).collect();
    let mut first_error = None;
    for result in join_all(workers).await {
        if let Err(error) = result {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

async fn join_all<Fut: Future>(futures: Vec<Fut>) -> Vec<Fut::Output> {
    let mut pinned: Vec<_> = futures.into_iter().map(Box::pin).collect();
    let mut outputs: Vec<Option<Fut::Output>> = pinned.iter().map(|_| None).collect();
    std::future::poll_fn(|cx| {
        let mut pending = false;
        for (future, output) in pinned.iter_mut().zip(outputs.iter_mut()) {
            if output.is_none() {
                match future.as_mut().poll(cx) {
                    std::task::Poll::Ready(value) => *output = Some(value),
                    std::task::Poll::Pending => pending = true,
                }
            }
        }
        if pending { std::task::Poll::Pending } else { std::task::Poll::Ready(()) }
    })
    .await;
    outputs.into_iter().flatten().collect()
}

async fn read_patches(
    repo: &Repo,
    range: &DiffRange,
    requested: &[String],
) -> RunnerResult<Vec<DiffPatchEntry>> {
    let mut paths: Vec<String> = Vec::new();
    for file in requested {
        if !paths.contains(file) {
            paths.push(file.clone());
        }
    }
    let untracked =
        if range.includes_untracked { list_untracked(repo, &paths).await?.0 } else { Vec::new() };
    let names_args = range_args(range, &NAME_STATUS, &[]);
    let names = repo.with(bounded(LISTING_MAX_BYTES)).git(&strs(&names_args)).await?;
    let renames = bb_git::parse_name_status_z(complete_records(&names));
    let patches: Arc<Mutex<HashMap<String, String>>> = Arc::default();
    let patch_repo = repo.with(bounded(DIFF_PATCH_MAX_BYTES_PER_FILE));
    let tracked: Vec<String> =
        paths.iter().filter(|file| !untracked.contains(file)).cloned().collect();
    map_limited(tracked, |file| {
        let previous = renames
            .iter()
            .find(|entry| entry.path == file)
            .and_then(|entry| entry.previous_path.clone());
        let pathspec = match previous {
            Some(previous) if !previous.is_empty() => vec![previous, file.clone()],
            _ => vec![file.clone()],
        };
        let args = range_args(range, &["--binary", "-M"], &pathspec);
        let (patch_repo, patches) = (&patch_repo, patches.clone());
        async move {
            let patch = patch_repo.git(&strs(&args)).await?;
            patches.lock().insert(file, patch.stdout);
            Ok(())
        }
    })
    .await?;
    if !untracked.is_empty() {
        let patches = patches.clone();
        bb_git::with_untracked_index(repo, &untracked, |index, indexed| async move {
            let index = index.with(bounded(DIFF_PATCH_MAX_BYTES_PER_FILE));
            map_limited(indexed, |file| {
                let args = ["diff".to_owned(), "--no-ext-diff".to_owned(), "--binary".to_owned()]
                    .into_iter()
                    .chain(["--".to_owned()])
                    .chain(literal(std::slice::from_ref(&file)))
                    .collect::<Vec<_>>();
                let (index, patches) = (&index, patches.clone());
                async move {
                    let patch = index.git(&strs(&args)).await?;
                    patches.lock().insert(file, patch.stdout);
                    Ok(())
                }
            })
            .await
        })
        .await?;
    }
    let patches = std::mem::take(&mut *patches.lock());
    let mut remaining = DIFF_RESPONSE_MAX_BYTES;
    Ok(paths
        .into_iter()
        .map(|file| {
            let limit = DIFF_PATCH_MAX_BYTES_PER_FILE.min(remaining);
            let (text, truncated) =
                truncate_utf8(patches.get(&file).map(String::as_str).unwrap_or(""), limit);
            remaining = remaining.saturating_sub(text.len());
            DiffPatchEntry { path: file, patch: text, truncated }
        })
        .collect())
}

pub async fn git_diff_files(ctx: &Ctx, args: DiffScope) -> RunnerResult<DiffFiles> {
    let ChangedFiles { repo, range, files, truncated } = list_changed_files(ctx, &args).await?;
    let inline: Vec<String> = files
        .iter()
        .filter(|file| file.load_mode == DiffLoadMode::Auto)
        .map(|file| file.path.clone())
        .collect();
    let too_many = files.len() > INLINE_PATCH_MAX_FILES || inline.is_empty();
    let initial_patches = match &range {
        Some(range) if !too_many => read_patches(&repo, range, &inline).await?,
        _ => Vec::new(),
    };
    Ok(DiffFiles {
        shortstat: shortstat(&files),
        files,
        truncated,
        merge_base_ref: range.and_then(|range| range.merge_base_ref),
        initial_patches,
    })
}

pub async fn git_diff_patch(ctx: &Ctx, args: DiffPatchArgs) -> RunnerResult<DiffPatches> {
    if args.paths.len() > DIFF_PATCH_MAX_PATHS {
        return fail(
            RunnerErrorCode::Failed,
            format!("At most {DIFF_PATCH_MAX_PATHS} paths per request"),
        );
    }
    let repo = bb_git::require_repo(ctx, &args.path).await?;
    let Some(range) = resolve_range(&repo, &args.target).await? else {
        let empty = |file: &String| DiffPatchEntry {
            path: file.clone(),
            patch: String::new(),
            truncated: false,
        };
        return Ok(DiffPatches { patches: args.paths.iter().map(empty).collect() });
    };
    Ok(DiffPatches { patches: read_patches(&repo, &range, &args.paths).await? })
}

fn diff_file_ref(file: &EnvironmentDiffFileQuery) -> Option<String> {
    use EnvironmentDiffFileQuery as Query;
    match file {
        Query::Uncommitted { side, .. } => (*side == DiffFileSide::Old).then(|| "HEAD".to_owned()),
        Query::BranchCommitted { merge_base_ref, side, .. } => Some(match side {
            DiffFileSide::Old => merge_base_ref.clone(),
            DiffFileSide::New => "HEAD".to_owned(),
        }),
        Query::All { merge_base_ref, side, .. } => {
            (*side == DiffFileSide::Old).then(|| merge_base_ref.clone())
        }
        Query::Commit { sha, side, .. } => Some(match side {
            DiffFileSide::Old => format!("{sha}^"),
            DiffFileSide::New => sha.clone(),
        }),
    }
}

pub async fn git_diff_file(ctx: &Ctx, args: DiffFileArgs) -> RunnerResult<FileContent> {
    let relative_path = args.file.path().trim_start_matches('/');
    if relative_path.is_empty() || relative_path.split('/').any(|part| part == "..") {
        return fail(RunnerErrorCode::InvalidPath, "Invalid diff file path");
    }
    let root = bb_git::require_repo(ctx, &args.path).await?.cwd;
    let file = bb_core::exec::normalize(&Path::new(&root).join(relative_path));
    read_file(
        ctx,
        ReadFileArgs {
            path: file.to_string_lossy().into_owned(),
            root_path: Some(root.to_string_lossy().into_owned()),
            git_ref: diff_file_ref(&args.file),
        },
    )
    .await
}
