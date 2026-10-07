use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use bb_core::exec::{Ctx, GitOptions, open_repo, require_absolute};
use bb_core::{RunnerErrorCode, RunnerResult, fail};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::fuzzy::fuzzy_match_paths;

pub const PATHS_EXIST_MAX_PATHS: usize = 200;
pub const PATH_LIST_MAX_ENTRIES: usize = 2_000;

const GIT_LISTING_MAX_BYTES: usize = 128 * 1024 * 1024;
const GIT_LISTING_TIMEOUT_MS: u64 = 10_000;
const LISTING_REUSE: Duration = Duration::from_millis(2_000);
const WALK_MAX_ENTRIES: usize = 100_000;
const BROWSE_SKIPPED_NAMES: [&str; 1] = ["node_modules"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PathKind {
    Directory,
    File,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPathsArgs {
    pub root_path: String,
    #[serde(default)]
    pub query: Option<String>,
    pub limit: i64,
    pub include_files: bool,
    pub include_directories: bool,
    #[serde(default)]
    pub include_hidden: Option<bool>,
    #[serde(default)]
    pub exclude_names: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WorkspacePathEntry {
    pub kind: PathKind,
    pub path: String,
    pub name: String,
    pub score: f64,
    pub positions: Vec<usize>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WorkspacePathListResponse {
    pub paths: Vec<WorkspacePathEntry>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct BrowseDirectoryArgs {
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostDirectoryEntry {
    pub kind: PathKind,
    pub name: String,
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostDirectoryListing {
    pub directory: String,
    pub parent: Option<String>,
    pub entries: Vec<HostDirectoryEntry>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct PathsExistArgs {
    pub paths: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PathsExistResult {
    pub existence: BTreeMap<String, bool>,
}

#[derive(Clone)]
struct ListedPath {
    kind: PathKind,
    path: String,
    name: String,
}

type Listing = Arc<Vec<ListedPath>>;

static RECENT_LISTINGS: LazyLock<Mutex<HashMap<String, (Instant, Listing)>>> =
    LazyLock::new(Mutex::default);

async fn git_files(ctx: &Ctx, root: &Path) -> RunnerResult<Option<Vec<String>>> {
    let options = GitOptions {
        max_bytes: Some(GIT_LISTING_MAX_BYTES),
        timeout_ms: Some(GIT_LISTING_TIMEOUT_MS),
        ..GitOptions::default()
    };
    let repo = open_repo(ctx, root).with(options);
    if bb_git::repo_kind(&repo).await? != bb_git::RepoKind::WorkTree {
        return Ok(None);
    }
    let (present, deleted) = tokio::try_join!(
        repo.git(&["ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
        repo.git(&["ls-files", "-z", "--deleted"]),
    )?;
    let gone: HashSet<String> = bb_git::split_nul(&deleted.stdout).into_iter().collect();
    let files: BTreeSet<String> = bb_git::split_nul(&present.stdout).into_iter().collect();
    Ok(Some(files.into_iter().filter(|file| !gone.contains(file)).collect()))
}

async fn walk_files(root: &Path) -> Vec<String> {
    let mut files = Vec::new();
    let mut pending = vec![String::new()];
    let mut visited = 0;
    while visited < WALK_MAX_ENTRIES {
        let Some(directory) = pending.pop() else { break };
        let Ok(mut entries) = tokio::fs::read_dir(root.join(&directory)).await else { continue };
        let mut listed = Vec::new();
        while let Ok(Some(entry)) = entries.next_entry().await {
            listed.push(entry);
        }
        visited += listed.len();
        for entry in listed {
            let name = entry.file_name().to_string_lossy().into_owned();
            let relative =
                if directory.is_empty() { name.clone() } else { format!("{directory}/{name}") };
            let Ok(kind) = entry.file_type().await else { continue };
            if kind.is_dir() && name != ".git" {
                pending.push(relative);
            } else if kind.is_file() {
                files.push(relative);
            }
        }
    }
    files.sort();
    files
}

fn with_directories(files: &[String], is_excluded: impl Fn(&str) -> bool) -> Vec<ListedPath> {
    let mut listed = Vec::new();
    let mut directories = HashSet::new();
    for file in files {
        let segments: Vec<&str> = file.split('/').collect();
        if is_excluded(file) || segments.iter().any(|segment| is_excluded(segment)) {
            continue;
        }
        for (index, name) in segments.iter().enumerate() {
            let path = segments[..=index].join("/");
            if index == segments.len() - 1 {
                listed.push(ListedPath { kind: PathKind::File, path, name: (*name).to_owned() });
            } else if directories.insert(path.clone()) {
                listed.push(ListedPath {
                    kind: PathKind::Directory,
                    path,
                    name: (*name).to_owned(),
                });
            }
        }
    }
    listed
}

async fn resolve_root(root: &str) -> RunnerResult<Option<PathBuf>> {
    let stat = match tokio::fs::symlink_metadata(root).await {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        other => other?,
    };
    if stat.file_type().is_symlink() || !stat.is_dir() {
        return fail(
            RunnerErrorCode::InvalidPath,
            format!("Root \"{root}\" must be a real directory"),
        );
    }
    Ok(Some(tokio::fs::canonicalize(root).await?))
}

pub async fn list_paths(ctx: &Ctx, args: ListPathsArgs) -> RunnerResult<WorkspacePathListResponse> {
    let absolute = require_absolute(&args.root_path, "Path")?;
    let Some(root) = resolve_root(absolute).await? else {
        return Ok(WorkspacePathListResponse { paths: Vec::new(), truncated: false });
    };
    let excluded: BTreeSet<String> = args.exclude_names.unwrap_or_default().into_iter().collect();
    let skip_hidden = args.include_hidden != Some(true);
    let key = serde_json::json!([root.to_string_lossy(), skip_hidden, excluded]).to_string();
    let recent = {
        let mut cache = RECENT_LISTINGS.lock();
        cache.retain(|_, (at, _)| at.elapsed() <= LISTING_REUSE);
        cache.get(&key).map(|(_, listing)| listing.clone())
    };
    let listing = match recent {
        Some(listing) => listing,
        None => {
            let files = match git_files(ctx, &root).await {
                Ok(Some(files)) => files,
                _ => walk_files(&root).await,
            };
            let is_excluded = |segment: &str| {
                excluded.contains(segment) || (skip_hidden && segment.starts_with('.'))
            };
            let listing: Listing = Arc::new(with_directories(&files, is_excluded));
            RECENT_LISTINGS.lock().insert(key, (Instant::now(), listing.clone()));
            listing
        }
    };
    let limit = args.limit.clamp(0, PATH_LIST_MAX_ENTRIES as i64) as usize;
    let items: Vec<&ListedPath> = listing
        .iter()
        .filter(|entry| match entry.kind {
            PathKind::File => args.include_files,
            PathKind::Directory => args.include_directories,
        })
        .collect();
    let texts: Vec<&str> = items.iter().map(|entry| entry.path.as_str()).collect();
    let ranked = fuzzy_match_paths(&texts, args.query.as_deref().unwrap_or(""), limit + 1);
    let truncated = ranked.len() > limit;
    let paths = ranked
        .into_iter()
        .take(limit)
        .map(|found| {
            let item = items[found.index];
            WorkspacePathEntry {
                kind: item.kind,
                path: item.path.clone(),
                name: item.name.clone(),
                score: found.score as f64,
                positions: found.positions,
            }
        })
        .collect();
    Ok(WorkspacePathListResponse { paths, truncated })
}

pub async fn browse_directory(
    _ctx: &Ctx,
    args: BrowseDirectoryArgs,
) -> RunnerResult<HostDirectoryListing> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_owned());
    let requested = require_absolute(args.path.as_deref().unwrap_or(&home), "Path")?.to_owned();
    if !tokio::fs::metadata(&requested).await?.is_dir() {
        return fail(
            RunnerErrorCode::InvalidPath,
            format!("Path \"{requested}\" is not a directory"),
        );
    }
    let directory = tokio::fs::canonicalize(&requested).await?;
    let mut entries = Vec::new();
    let mut reader = tokio::fs::read_dir(&directory).await?;
    while let Some(entry) = reader.next_entry().await? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || BROWSE_SKIPPED_NAMES.contains(&name.as_str()) {
            continue;
        }
        let path = directory.join(&name);
        let Ok(stat) = tokio::fs::metadata(&path).await else { continue };
        let kind = if stat.is_dir() {
            PathKind::Directory
        } else if stat.is_file() {
            PathKind::File
        } else {
            continue;
        };
        entries.push(HostDirectoryEntry { kind, name, path: path.to_string_lossy().into_owned() });
    }
    entries.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    entries.truncate(PATH_LIST_MAX_ENTRIES);
    let parent = directory.parent().map(|above| above.to_string_lossy().into_owned());
    Ok(HostDirectoryListing {
        directory: directory.to_string_lossy().into_owned(),
        parent,
        entries,
    })
}

pub async fn paths_exist(_ctx: &Ctx, args: PathsExistArgs) -> RunnerResult<PathsExistResult> {
    if args.paths.len() > PATHS_EXIST_MAX_PATHS {
        return fail(
            RunnerErrorCode::Failed,
            format!("At most {PATHS_EXIST_MAX_PATHS} paths per request"),
        );
    }
    let mut existence = BTreeMap::new();
    for target in args.paths {
        let found = match tokio::fs::metadata(&target).await {
            Ok(_) => true,
            Err(error) => !matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ),
        };
        existence.insert(target, found);
    }
    Ok(PathsExistResult { existence })
}
