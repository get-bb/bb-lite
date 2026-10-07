use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use bb_core::exec::{Ctx, GitOptions, is_inside, normalize, open_repo};
use bb_core::{RunnerEvent, RunnerEventBody, RunnerResult};
use notify::{RecommendedWatcher, RecursiveMode, Watcher as _};
use parking_lot::Mutex;
use serde::Deserialize;
use tokio::sync::mpsc;
use tokio::time::Instant;

const DEBOUNCE: Duration = Duration::from_millis(75);
const MAX_WAIT: Duration = Duration::from_millis(500);
const IGNORE_DISCOVERY_TIMEOUT_MS: u64 = 5_000;
const IGNORE_DISCOVERY_MAX_BYTES: usize = 10 * 1024 * 1024;
const WORKSPACE_IGNORED_NAMES: [&str; 3] = ["node_modules", ".cache", "__pycache__"];
const COMMON_DIR_IGNORED: [&str; 6] = ["hooks", "info", "logs", "modules", "objects", "worktrees"];

#[derive(Clone, Debug, Deserialize)]
pub struct SetWatchedPathsArgs {
    pub generation: f64,
    pub workspaces: Vec<String>,
    pub directories: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Change {
    Status,
    Refs,
    Files,
}

impl Change {
    fn as_str(self) -> &'static str {
        match self {
            Self::Status => "status",
            Self::Refs => "refs",
            Self::Files => "files",
        }
    }
}

#[derive(Clone, Copy)]
enum Tree {
    Workspace { git_aware: bool },
    GitDir { shared: bool },
    CommonDir,
    Directory,
}

struct Subscription {
    root: PathBuf,
    tree: Tree,
    ignored: Vec<String>,
}

struct Stop {
    alive: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<()>,
    _watchers: Vec<RecommendedWatcher>,
}

impl Stop {
    fn stop(self) {
        self.alive.store(false, Ordering::SeqCst);
        self.task.abort();
    }
}

#[derive(Default)]
struct State {
    active: HashMap<String, Stop>,
    latest_generation: Option<f64>,
}

/// Watches workspaces and plain directories, emitting `workspace.changed` to `ctx.sink`.
#[derive(Clone)]
pub struct Watcher {
    ctx: Ctx,
    state: Arc<Mutex<State>>,
}

pub fn create_watcher(ctx: &Ctx) -> Watcher {
    Watcher { ctx: ctx.clone(), state: Arc::default() }
}

impl Watcher {
    pub async fn set_watched_paths(&self, args: SetWatchedPathsArgs) -> RunnerResult<()> {
        self.ctx
            .lock
            .run("watched-paths", async {
                {
                    let mut state = self.state.lock();
                    if state.latest_generation.is_some_and(|latest| args.generation <= latest) {
                        return;
                    }
                    state.latest_generation = Some(args.generation);
                }
                let mut wanted: Vec<(String, bool, String)> = Vec::new();
                let targets = args.workspaces.iter().map(|target| (true, target));
                for (workspace, target) in
                    targets.chain(args.directories.iter().map(|target| (false, target)))
                {
                    let kind = if workspace { "workspace" } else { "directory" };
                    let key = format!("{kind}\0{target}");
                    if !wanted.iter().any(|(existing, ..)| *existing == key) {
                        wanted.push((key, workspace, target.clone()));
                    }
                }
                {
                    let mut state = self.state.lock();
                    let stale: Vec<String> = state
                        .active
                        .keys()
                        .filter(|key| !wanted.iter().any(|(wanted, ..)| wanted == *key))
                        .cloned()
                        .collect();
                    for key in stale {
                        if let Some(stop) = state.active.remove(&key) {
                            stop.stop();
                        }
                    }
                }
                for (key, workspace, target) in wanted {
                    if self.state.lock().active.contains_key(&key) {
                        continue;
                    }
                    let started = if workspace {
                        watch_workspace(&self.ctx, &target).await
                    } else {
                        watch_directory(&self.ctx, &target).await
                    };
                    if let Some(subscriptions) = started
                        && let Some(stop) = start(&self.ctx, &target, subscriptions)
                    {
                        self.state.lock().active.insert(key, stop);
                    }
                }
            })
            .await;
        Ok(())
    }

    pub async fn dispose(&self) -> RunnerResult<()> {
        self.ctx
            .lock
            .run("watched-paths", async {
                for (_, stop) in self.state.lock().active.drain() {
                    stop.stop();
                }
            })
            .await;
        Ok(())
    }
}

async fn git_layout(root: &Path) -> Option<(PathBuf, PathBuf)> {
    let dot_git = root.join(".git");
    let stat = tokio::fs::symlink_metadata(&dot_git).await.ok()?;
    let pointer = if stat.is_file() {
        let text = tokio::fs::read_to_string(&dot_git).await.ok()?;
        text.lines()
            .find_map(|line| line.strip_prefix("gitdir:"))
            .map(|rest| rest.trim().to_owned())?
    } else {
        ".git".to_owned()
    };
    let git_dir = tokio::fs::canonicalize(normalize(&root.join(pointer))).await.ok()?;
    let common = tokio::fs::read_to_string(git_dir.join("commondir"))
        .await
        .unwrap_or_else(|_| ".".to_owned());
    let common_dir = tokio::fs::canonicalize(normalize(&git_dir.join(common.trim()))).await.ok()?;
    Some((git_dir, common_dir))
}

async fn ignored_directories(ctx: &Ctx, root: &Path) -> Vec<String> {
    let options = GitOptions {
        timeout_ms: Some(IGNORE_DISCOVERY_TIMEOUT_MS),
        max_bytes: Some(IGNORE_DISCOVERY_MAX_BYTES),
        ..GitOptions::default()
    };
    let flags =
        ["status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=normal"];
    let stdout = match open_repo(ctx, root).with(options).git(&flags).await {
        Ok(status) => status.stdout,
        Err(_) => String::new(),
    };
    bb_git::split_nul(&stdout)
        .into_iter()
        .filter_map(|record| record.strip_prefix("!! ")?.strip_suffix('/').map(str::to_owned))
        .collect()
}

async fn watch_workspace(ctx: &Ctx, workspace_path: &str) -> Option<Vec<Subscription>> {
    let root = tokio::fs::canonicalize(workspace_path).await.ok()?;
    let Some((git_dir, common_dir)) = git_layout(&root).await else {
        let tree = Tree::Workspace { git_aware: false };
        return Some(vec![Subscription { root, tree, ignored: Vec::new() }]);
    };
    let shared = git_dir == common_dir;
    let ignored = ignored_directories(ctx, &root).await;
    let mut subscriptions = vec![
        Subscription { root, tree: Tree::Workspace { git_aware: true }, ignored },
        Subscription { root: git_dir, tree: Tree::GitDir { shared }, ignored: Vec::new() },
    ];
    if !shared {
        subscriptions.push(Subscription {
            root: common_dir,
            tree: Tree::CommonDir,
            ignored: Vec::new(),
        });
    }
    Some(subscriptions)
}

async fn watch_directory(ctx: &Ctx, directory: &str) -> Option<Vec<Subscription>> {
    if is_inside(&ctx.data_dir, &normalize(Path::new(directory))) {
        tokio::fs::create_dir_all(directory).await.ok()?;
    }
    let root = tokio::fs::canonicalize(directory).await.ok()?;
    Some(vec![Subscription { root, tree: Tree::Directory, ignored: Vec::new() }])
}

fn is_shared_ref(relative: &str) -> bool {
    relative == "packed-refs"
        || relative.starts_with("refs/heads/")
        || relative.starts_with("refs/remotes/")
}

fn classify(subscription: &Subscription, relative: &str) -> &'static [Change] {
    let segments: Vec<&str> = relative.split('/').collect();
    let first = segments.first().copied().unwrap_or("");
    match subscription.tree {
        Tree::Directory => &[Change::Files],
        Tree::Workspace { git_aware } => {
            let nested_git = segments.iter().skip(1).any(|segment| *segment == ".git");
            let noise = segments.iter().any(|segment| WORKSPACE_IGNORED_NAMES.contains(segment));
            let ignored = subscription
                .ignored
                .iter()
                .any(|dir| relative == dir || relative.starts_with(&format!("{dir}/")));
            if nested_git || noise || (git_aware && (first == ".git" || ignored)) {
                &[]
            } else {
                &[Change::Status]
            }
        }
        Tree::GitDir { shared } => {
            let name = segments.last().copied().unwrap_or("");
            if (shared && COMMON_DIR_IGNORED.contains(&first))
                || name.ends_with(".lock")
                || relative.ends_with(".lock")
                || relative == "commondir"
                || relative == "gitdir"
            {
                &[]
            } else if relative == "HEAD" || (shared && is_shared_ref(relative)) {
                &[Change::Status, Change::Refs]
            } else {
                &[Change::Status]
            }
        }
        Tree::CommonDir => {
            if COMMON_DIR_IGNORED.contains(&first) || relative.ends_with(".lock") {
                &[]
            } else if is_shared_ref(relative) {
                &[Change::Refs]
            } else {
                &[]
            }
        }
    }
}

fn start(ctx: &Ctx, target: &str, subscriptions: Vec<Subscription>) -> Option<Stop> {
    let (sender, mut receiver) = mpsc::unbounded_channel::<Vec<Change>>();
    let mut watchers = Vec::new();
    for subscription in subscriptions {
        let sender = sender.clone();
        let root = subscription.root.clone();
        let mut watcher =
            notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                let changes: Vec<Change> = match result {
                    Err(_) => vec![Change::Status, Change::Refs],
                    Ok(event) => event
                        .paths
                        .iter()
                        .filter_map(|path| path.strip_prefix(&subscription.root).ok())
                        .flat_map(|relative| {
                            let relative = relative.to_string_lossy().replace('\\', "/");
                            classify(&subscription, &relative).to_vec()
                        })
                        .collect(),
                };
                if !changes.is_empty() {
                    let _ = sender.send(changes);
                }
            })
            .ok()?;
        watcher.watch(&root, RecursiveMode::Recursive).ok()?;
        watchers.push(watcher);
    }
    let alive = Arc::new(AtomicBool::new(true));
    let (sink, path, flag) = (ctx.sink.clone(), target.to_owned(), alive.clone());
    let task = tokio::spawn(async move {
        while let Some(first) = receiver.recv().await {
            let mut pending: BTreeSet<Change> = first.into_iter().collect();
            let deadline = Instant::now() + MAX_WAIT;
            loop {
                let wait = (Instant::now() + DEBOUNCE).min(deadline);
                match tokio::time::timeout_at(wait, receiver.recv()).await {
                    Ok(Some(more)) if Instant::now() < deadline => pending.extend(more),
                    Ok(Some(more)) => {
                        pending.extend(more);
                        break;
                    }
                    Ok(None) => return,
                    Err(_) => break,
                }
            }
            for change in pending {
                if flag.load(Ordering::SeqCst) {
                    let body = RunnerEventBody::WorkspaceChanged {
                        path: path.clone(),
                        change: change.as_str().to_owned(),
                    };
                    sink(RunnerEvent::unsequenced(body));
                }
            }
        }
    });
    Some(Stop { alive, task, _watchers: watchers })
}
