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
    /// Owns the watchers, so aborting it stops the watching.
    task: tokio::task::JoinHandle<()>,
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
            if nested_git || noise || first == ".git" || (git_aware && ignored) {
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

/// Whether an event at or below `relative` (a directory of the subscription) can classify as a
/// change. Directories that cannot are not watched at all.
fn watches_directory(subscription: &Subscription, relative: &str) -> bool {
    if relative.is_empty() {
        return true;
    }
    match subscription.tree {
        Tree::Directory | Tree::GitDir { shared: false } => true,
        Tree::Workspace { .. } => !classify(subscription, relative).is_empty(),
        Tree::GitDir { shared: true } => {
            let first = relative.split('/').next().unwrap_or("");
            !COMMON_DIR_IGNORED.contains(&first)
        }
        Tree::CommonDir => {
            relative == "refs"
                || [relative, "x"].join("/").starts_with("refs/heads/")
                || [relative, "x"].join("/").starts_with("refs/remotes/")
        }
    }
}

fn relative_to(subscription: &Subscription, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(&subscription.root).ok()?;
    Some(relative.to_string_lossy().replace('\\', "/"))
}

/// Watches `start` and every directory below it whose events can matter, without following
/// symlinks. A pnpm `node_modules` reached through its symlinks is several hundred thousand
/// directories; none of them can produce a change.
fn watch_tree(
    watcher: &mut RecommendedWatcher,
    subscription: &Subscription,
    start: &Path,
) -> notify::Result<()> {
    let mut paths = watcher.paths_mut();
    let mut pending = vec![start.to_path_buf()];
    while let Some(directory) = pending.pop() {
        if let Err(error) = paths.add(&directory, RecursiveMode::NonRecursive) {
            if directory == subscription.root {
                return Err(error);
            }
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&directory) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let wanted = entry.file_type().is_ok_and(|kind| kind.is_dir())
                && relative_to(subscription, &path)
                    .is_some_and(|relative| watches_directory(subscription, &relative));
            if wanted {
                pending.push(path);
            }
        }
    }
    paths.commit()
}

enum Signal {
    Changed(Vec<Change>),
    /// A directory appeared in the subscription with this index, in this epoch of the watch.
    Created(u64, usize, PathBuf),
    /// A repository appeared in a workspace that had none when this epoch of the watch began.
    Repository(u64),
}

fn signals(
    subscription: &Subscription,
    epoch: u64,
    index: usize,
    event: notify::Event,
) -> Vec<Signal> {
    use notify::EventKind;
    use notify::event::ModifyKind;
    if matches!(event.kind, EventKind::Access(_)) {
        return Vec::new();
    }
    let appeared =
        matches!(event.kind, EventKind::Create(_) | EventKind::Modify(ModifyKind::Name(_)));
    let plain = matches!(subscription.tree, Tree::Workspace { git_aware: false });
    let mut changes = Vec::new();
    let mut found = Vec::new();
    for path in event.paths {
        let Some(relative) = relative_to(subscription, &path) else { continue };
        changes.extend_from_slice(classify(subscription, &relative));
        if !appeared {
            continue;
        }
        if plain && relative == ".git" {
            found.push(Signal::Repository(epoch));
        } else if watches_directory(subscription, &relative)
            && std::fs::symlink_metadata(&path).is_ok_and(|stat| stat.is_dir())
        {
            found.push(Signal::Created(epoch, index, path));
        }
    }
    if !changes.is_empty() {
        found.push(Signal::Changed(changes));
    }
    found
}

type Watched = Vec<(Arc<Subscription>, RecommendedWatcher)>;

fn open(
    subscriptions: Vec<Subscription>,
    epoch: u64,
    sender: &mpsc::UnboundedSender<Signal>,
) -> Option<Watched> {
    let mut watched = Vec::new();
    for (index, subscription) in subscriptions.into_iter().enumerate() {
        let subscription = Arc::new(subscription);
        let (sender, seen) = (sender.clone(), subscription.clone());
        let config = notify::Config::default().with_follow_symlinks(false);
        let mut watcher = RecommendedWatcher::new(
            move |result: notify::Result<notify::Event>| {
                let found = match result {
                    Err(_) => vec![Signal::Changed(vec![Change::Status, Change::Refs])],
                    Ok(event) => signals(&seen, epoch, index, event),
                };
                for signal in found {
                    let _ = sender.send(signal);
                }
            },
            config,
        )
        .ok()?;
        watch_tree(&mut watcher, &subscription, &subscription.root).ok()?;
        watched.push((subscription, watcher));
    }
    Some(watched)
}

fn start(ctx: &Ctx, target: &str, subscriptions: Vec<Subscription>) -> Option<Stop> {
    let (sender, mut receiver) = mpsc::unbounded_channel::<Signal>();
    let mut epoch = 0;
    let mut watched = open(subscriptions, epoch, &sender)?;
    let alive = Arc::new(AtomicBool::new(true));
    let (ctx, path, flag) = (ctx.clone(), target.to_owned(), alive.clone());
    let task = tokio::spawn(async move {
        let mut pending: BTreeSet<Change> = BTreeSet::new();
        let mut deadline: Option<Instant> = None;
        loop {
            let signal = match deadline {
                None => receiver.recv().await,
                Some(deadline) => {
                    let wait = (Instant::now() + DEBOUNCE).min(deadline);
                    match tokio::time::timeout_at(wait, receiver.recv()).await {
                        Ok(signal) => signal,
                        Err(_) => Some(Signal::Changed(Vec::new())),
                    }
                }
            };
            let quiet = match signal {
                None => return,
                Some(Signal::Created(from, index, directory)) => {
                    if from == epoch
                        && let Some((subscription, watcher)) = watched.get_mut(index)
                    {
                        let _ = watch_tree(watcher, subscription, &directory);
                    }
                    false
                }
                Some(Signal::Repository(from)) => {
                    if from == epoch
                        && let Some(subscriptions) = watch_workspace(&ctx, &path).await
                        && subscriptions.len() > 1
                        && let Some(opened) = open(subscriptions, epoch + 1, &sender)
                    {
                        epoch += 1;
                        watched = opened;
                        pending.extend([Change::Status, Change::Refs]);
                    }
                    false
                }
                Some(Signal::Changed(changes)) => {
                    let quiet = changes.is_empty();
                    pending.extend(changes);
                    quiet
                }
            };
            if pending.is_empty() {
                continue;
            }
            let due = *deadline.get_or_insert_with(|| Instant::now() + MAX_WAIT);
            if !quiet && Instant::now() < due {
                continue;
            }
            deadline = None;
            for change in std::mem::take(&mut pending) {
                if flag.load(Ordering::SeqCst) {
                    let body = RunnerEventBody::WorkspaceChanged {
                        path: path.clone(),
                        change: change.as_str().to_owned(),
                    };
                    (ctx.sink)(RunnerEvent::unsequenced(body));
                }
            }
        }
    });
    Some(Stop { alive, task })
}
