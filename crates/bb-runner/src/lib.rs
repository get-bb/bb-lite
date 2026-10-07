//! Port of runner/src/local.ts and runner/src/workspace/index.ts: one machine's runner, sessions
//! and workspace behind `bb_core::RunnerApi::call`.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use bb_core::env::{EnvMap, login_shell_env};
use bb_core::exec::{Ctx, KeyedLock};
use bb_core::{
    RunnerApi, RunnerError, RunnerEvent, RunnerEventBody, RunnerEventSink, RunnerResult,
};
use bb_procs::{LifecycleScripts, Terminals};
use bb_provider::ProviderAdapter;
use bb_remote::Outbox;
use bb_remote::daemon::{LocalFactory, LocalParts, LocalSetup};
use bb_sessions::{SESSION_METHODS, SessionManager, SessionManagerOptions, SessionTiming};
use bb_workspace::watch::{Watcher, create_watcher};
use bb_workspace::{diff, list, worktrees};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

pub struct LocalRunnerOptions {
    pub data_dir: PathBuf,
    pub server_url: String,
    pub bb_cli_path: String,
    pub sink: RunnerEventSink,
    pub adapters: Vec<Arc<dyn ProviderAdapter>>,
}

/// The providers a machine offers when the caller does not choose.
pub fn default_adapters() -> Vec<Arc<dyn ProviderAdapter>> {
    // TODO(bb-codex, bb-claude): prepend `bb_codex::create_codex_adapter()` and
    // `bb_claude::create_claude_adapter()` here, in that order, once those crates are finished.
    vec![bb_echo::create_echo_adapter()]
}

pub struct LocalRunner {
    outbox: Arc<Outbox>,
    sessions: SessionManager,
    workspace: Workspace,
}

struct Workspace {
    ctx: Ctx,
    scripts: LifecycleScripts,
    terminals: Terminals,
    watcher: Watcher,
}

fn dirname(path: &str) -> String {
    match Path::new(path).parent().map(|parent| parent.to_string_lossy().into_owned()) {
        Some(parent) if parent.is_empty() => ".".to_owned(),
        Some(parent) => parent,
        None if path.starts_with('/') => "/".to_owned(),
        None => ".".to_owned(),
    }
}

pub fn create_local_runner(options: LocalRunnerOptions) -> LocalRunner {
    let outbox = Outbox::new(options.sink.clone());
    let mut extra = EnvMap::new();
    extra.insert("BB_CLI".to_owned(), options.bb_cli_path.clone());
    extra.insert("BB_SERVER_URL".to_owned(), options.server_url.clone());
    let to_outbox = outbox.clone();
    let to_sink = options.sink.clone();
    let sink: RunnerEventSink = Arc::new(move |event: RunnerEvent| match event.body {
        body @ RunnerEventBody::ScriptOutput { .. } => to_outbox.emit(body),
        _ => to_sink(event),
    });
    let ctx = Ctx {
        data_dir: std::path::absolute(&options.data_dir).unwrap_or(options.data_dir.clone()),
        sink,
        env: login_shell_env(extra, dirname(&options.bb_cli_path)),
        lock: KeyedLock::new(),
    };
    let workspace = Workspace {
        scripts: LifecycleScripts::new(ctx.clone()),
        terminals: Terminals::new(ctx.clone()),
        watcher: create_watcher(&ctx),
        ctx,
    };
    let terminals = workspace.terminals.clone();
    let sessions = SessionManager::new(SessionManagerOptions {
        data_dir: options.data_dir,
        server_url: options.server_url,
        bb_cli_path: options.bb_cli_path,
        outbox: outbox.clone(),
        adapters: options.adapters,
        terminal_ids: Some(Arc::new(move || terminals.live_ids())),
        login_path: None,
        timing: SessionTiming::default(),
    });
    LocalRunner { outbox, sessions, workspace }
}

/// The `bb runner` daemon's factory for the machine it runs on.
pub fn local_factory(bb_cli_path: String, adapters: Vec<Arc<dyn ProviderAdapter>>) -> LocalFactory {
    Box::new(move |setup: LocalSetup| {
        create_local_runner(LocalRunnerOptions {
            data_dir: setup.data_dir,
            server_url: setup.server_url,
            bb_cli_path,
            sink: setup.sink,
            adapters,
        })
        .into_local_parts()
    })
}

impl LocalRunner {
    pub fn outbox(&self) -> &Arc<Outbox> {
        &self.outbox
    }

    pub fn sessions(&self) -> &SessionManager {
        &self.sessions
    }

    pub fn terminal_ids(&self) -> Vec<String> {
        self.workspace.terminals.live_ids()
    }

    pub async fn shutdown(&self) {
        self.sessions.shutdown().await;
        self.workspace.terminals.dispose();
        let _ = tokio::join!(self.workspace.scripts.dispose(), self.workspace.watcher.dispose());
    }

    pub fn into_local_parts(self) -> LocalParts {
        let outbox = self.outbox.clone();
        let runner = Arc::new(self);
        let stopping = runner.clone();
        LocalParts {
            runner,
            outbox,
            shutdown: Box::new(move || Box::pin(async move { stopping.shutdown().await })),
        }
    }

    async fn workspace_call(&self, method: &str, params: Value) -> RunnerResult<Value> {
        let ctx = &self.workspace.ctx;
        let scripts = &self.workspace.scripts;
        let terminals = &self.workspace.terminals;
        let watcher = &self.workspace.watcher;
        match method {
            "inspectPath" => bind(method, params, |a| bb_git::inspect_path(ctx, a)).await,
            "inspectGitSource" => {
                bind(method, params, |a| bb_git::inspect_git_source(ctx, a)).await
            }
            "listBranches" => bind(method, params, |a| bb_git::list_branches(ctx, a)).await,
            "gitStatus" => bind(method, params, |a| bb_git::git_status(ctx, a)).await,
            "gitDiffFiles" => bind(method, params, |a| diff::git_diff_files(ctx, a)).await,
            "gitDiffPatch" => bind(method, params, |a| diff::git_diff_patch(ctx, a)).await,
            "gitDiffFile" => bind(method, params, |a| diff::git_diff_file(ctx, a)).await,
            "gitCommit" => bind(method, params, |a| bb_git::git_commit(ctx, a)).await,
            "createWorktree" => bind(method, params, |a| worktrees::create_worktree(ctx, a)).await,
            "removeWorktree" => bind(method, params, |a| worktrees::remove_worktree(ctx, a)).await,
            "ensurePersonalWorkspace" => {
                bind(method, params, |a| worktrees::ensure_personal_workspace(ctx, a)).await
            }
            "switchBranch" => bind(method, params, |a| worktrees::switch_branch(ctx, a)).await,
            "runLifecycleScript" => bind(method, params, |a| scripts.run(a)).await,
            "cancelOperation" => bind(method, params, |a| scripts.cancel(a)).await,
            "readFile" => bind(method, params, |a| bb_fs::read_file(ctx, a)).await,
            "readFileChunk" => bind(method, params, |a| bb_fs::read_file_chunk(ctx, a)).await,
            "writeFile" => bind(method, params, |a| bb_fs::write_file(ctx, a)).await,
            "writeFileChunk" => bind(method, params, |a| bb_fs::write_file_chunk(ctx, a)).await,
            "listPaths" => bind(method, params, |a| list::list_paths(ctx, a)).await,
            "browseDirectory" => bind(method, params, |a| list::browse_directory(ctx, a)).await,
            "pathsExist" => bind(method, params, |a| list::paths_exist(ctx, a)).await,
            "mutatePath" => bind(method, params, |a| bb_fs::mutate_path(ctx, a)).await,
            "listCommands" => bind(method, params, |a| bb_fs::list_commands(ctx, a)).await,
            "openTerminal" => bind(method, params, |a| terminals.open(a)).await,
            "attachTerminal" => bind(method, params, |a| terminals.attach(a)).await,
            "writeTerminal" => bind(method, params, |a| terminals.write(a)).await,
            "resizeTerminal" => bind(method, params, |a| terminals.resize(a)).await,
            "closeTerminal" => bind(method, params, |a| terminals.close(a)).await,
            "setWatchedPaths" => bind(method, params, |a| watcher.set_watched_paths(a)).await,
            "listOpenTargets" => encode(bb_procs::list_open_targets(ctx).await),
            "openInTarget" => bind(method, params, |a| bb_procs::open_in_target(ctx, a)).await,
            _ => Err(RunnerError::failed(format!("Unknown runner method: {method}"))),
        }
    }
}

async fn bind<A, R, F>(method: &str, params: Value, run: impl FnOnce(A) -> F) -> RunnerResult<Value>
where
    A: DeserializeOwned,
    R: Serialize,
    F: Future<Output = RunnerResult<R>>,
{
    let args = serde_json::from_value(params).map_err(|error| {
        RunnerError::failed(format!("Invalid parameters for {method}: {error}"))
    })?;
    encode(run(args).await)
}

fn encode<R: Serialize>(result: RunnerResult<R>) -> RunnerResult<Value> {
    Ok(serde_json::to_value(result?)?)
}

#[async_trait]
impl RunnerApi for LocalRunner {
    async fn call(&self, method: &str, params: Value) -> RunnerResult<Value> {
        let params = if params.is_null() { json!({}) } else { params };
        if SESSION_METHODS.contains(&method) {
            if let Some(result) = self.sessions.call(method, params).await {
                return result;
            }
            return Err(RunnerError::failed(format!("Unknown runner method: {method}")));
        }
        self.workspace_call(method, params).await
    }
}
