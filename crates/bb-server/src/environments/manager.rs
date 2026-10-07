//! Creates, prepares, retires and removes the directories threads run in.
//! The port of `apps/server/src/environments/manager.ts`.

use std::collections::HashSet;
use std::sync::{Arc, Weak};
use std::time::Duration;

use bb_core::SharedRunner;
use parking_lot::Mutex;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use super::scripts::{self, ScriptListeners, Workspace, cancelled, not_ready, step};
use super::types::{EnsureEnvironmentArgs as Job, EnvironmentIntent, ThreadEnvironment};
use crate::context::{Ctx, ServerContext};
use crate::db::environments::{self as store, EnvironmentPatch, NewEnvironment};
use crate::db::projects::{DeletedProject, SourceSelector, get_project_source};
use crate::db::settings::get_app_settings;
use crate::db::threads::{ThreadRow, get_thread};
use crate::domain::changes::EnvironmentChangeKind;
use crate::domain::environment::{Environment, EnvironmentStatus, TeardownStatus};
use crate::error::{ApiError, ApiResult, error_message, invalid_request};
use crate::terminals::sessions::close_terminals_for;
use crate::threads::core::ThreadSerial;

const RETIRE_GRACE_MS: i64 = 5 * 60_000;
const TEARDOWN_RETRY_MS: i64 = 60_000;
const MAX_TEARDOWN_ATTEMPTS: i64 = 5;
const SWEEP_INTERVAL: Duration = Duration::from_millis(10_000);
const BRANCH_SLUG_MAX_LENGTH: usize = 48;
const INSTRUCTIONS_FILE: &str = ".bb/AGENTS.md";
const INSTRUCTIONS_MAX_LENGTH: usize = 32_000;
const AT_PATH: &str = "e.project_id = ? AND e.host_id = ? AND e.path = ?";
const OWNED_BY: &str = "e.owner_thread_id = ?";
const NO_CHECKOUT: &str = "This project has no checkout on the chosen machine.";
const SHARED_CHECKOUT: &str = "Cannot checkout branch while another thread is using this workspace";

/// The manager's in-memory state (per-environment queue, what is being retired).
#[derive(Default)]
pub struct EnvironmentsState {
    queue: ThreadSerial,
    retiring: Mutex<HashSet<String>>,
    pub(super) scripts: ScriptListeners,
}

#[derive(Deserialize, Default)]
struct CheckoutInputs {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    branch: Option<CheckoutBranch>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum CheckoutBranch {
    Existing {
        name: String,
    },
    New {
        #[serde(rename = "baseBranch")]
        base_branch: String,
    },
}

#[derive(Deserialize)]
#[serde(untagged)]
enum WorktreeInputs {
    Existing(ExistingWorktree),
    Fresh(FreshWorktree),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExistingWorktree {
    #[allow(dead_code)]
    kind: ExistingKind,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum ExistingKind {
    Existing,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct FreshWorktree {
    #[serde(default)]
    branch: WorktreeBranch,
}

#[derive(Deserialize, Default)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum WorktreeBranch {
    Named {
        name: String,
    },
    #[default]
    Default,
}

pub fn managed_branch_name(prefix: &str, thread: &ThreadRow) -> String {
    let title = thread.title.as_deref().or(thread.title_fallback.as_deref()).unwrap_or("");
    let mut slug = String::new();
    for char in title.to_lowercase().chars() {
        if char.is_ascii_lowercase() || char.is_ascii_digit() {
            slug.push(char);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.strip_prefix('-').unwrap_or(&slug);
    let slug: String = slug.chars().take(BRANCH_SLUG_MAX_LENGTH).collect();
    let slug = slug.strip_suffix('-').unwrap_or(&slug);
    if slug.is_empty() {
        format!("{prefix}{}", thread.id)
    } else {
        format!("{prefix}{slug}-{}", thread.id)
    }
}

fn in_use() -> EnvironmentPatch {
    EnvironmentPatch {
        retire_at: Some(None),
        teardown_status: Some(None),
        teardown_attempt: Some(0),
        teardown_message: Some(None),
        ..Default::default()
    }
}

fn require(ctx: &Ctx, id: &str) -> ApiResult<Environment> {
    store::get_environment(&ctx.db, id)?
        .ok_or_else(|| ApiError::new(404, "environment_not_found", "Environment not found"))
}

fn patch(ctx: &Ctx, id: &str, changes: EnvironmentPatch) -> ApiResult<Environment> {
    store::update_environment(&ctx.db, id, &changes)?;
    let kind = match changes.status {
        Some(_) => EnvironmentChangeKind::StatusChanged,
        None => EnvironmentChangeKind::MetadataChanged,
    };
    ctx.hub.environment(id, vec![kind]);
    require(ctx, id)
}

fn create(ctx: &Ctx, input: &NewEnvironment) -> ApiResult<Environment> {
    let id = store::insert_environment(&ctx.db, input)?;
    ctx.hub.environment(&id, vec![EnvironmentChangeKind::EnvironmentCreated]);
    require(ctx, &id)
}

fn discard(ctx: &Ctx, id: &str) -> ApiResult<()> {
    ctx.db.run("DELETE FROM environments WHERE id = ?", [id])?;
    ctx.hub.environment(id, vec![EnvironmentChangeKind::EnvironmentDeleted]);
    Ok(())
}

fn source_path_of(ctx: &Ctx, project_id: &str, host_id: &str) -> ApiResult<String> {
    match get_project_source(&ctx.db, project_id, SourceSelector::HostId(host_id))? {
        Some(source) => Ok(source.path),
        None => Err(not_ready(NO_CHECKOUT)),
    }
}

fn branch_name_for(ctx: &Ctx, thread: &ThreadRow) -> ApiResult<String> {
    Ok(managed_branch_name(&get_app_settings(&ctx.db)?.managed_branch_prefix, thread))
}

async fn call<T: DeserializeOwned>(
    runner: &SharedRunner,
    method: &str,
    args: Value,
) -> ApiResult<T> {
    Ok(serde_json::from_value(runner.call(method, args).await?)?)
}

fn string_at(value: &Value, pointer: &str) -> Option<String> {
    value.pointer(pointer).and_then(Value::as_str).map(str::to_owned)
}

fn check_signal(job: &Job) -> ApiResult<()> {
    if job.signal.is_cancelled() { Err(cancelled()) } else { Ok(()) }
}

async fn add_worktree(
    ctx: &Ctx,
    found: &Environment,
    runner: &SharedRunner,
    job: &Job,
    base: Option<String>,
) -> ApiResult<String> {
    let source_path = source_path_of(ctx, &found.project_id, &found.host_id)?;
    let branch_name = match &found.branch_name {
        Some(name) => name.clone(),
        None => branch_name_for(ctx, &job.thread)?,
    };
    if found.branch_name.is_some() {
        let query = json!({ "path": source_path, "selectedBranch": branch_name, "limit": 1 });
        let listed: Value = call(runner, "listBranches", query).await?;
        if listed.pointer("/selectedBranch/kind").and_then(Value::as_str) != Some("local") {
            let gone = format!("Branch {branch_name} no longer exists");
            return Err(not_ready(format!("{gone}, so its worktree cannot be restored.")));
        }
    }
    let started_at = ctx.now();
    (job.on_progress)(vec![step(
        "git-worktree-started",
        "Creating worktree",
        "started",
        started_at,
        None,
    )]);
    let key = found.environment_provider_instance_key.clone().unwrap_or_else(|| found.id.clone());
    let base_branch = found.merge_base_branch.clone().or(base);
    let worktree = json!({
        "sourcePath": source_path, "key": key, "branchName": branch_name, "baseBranch": base_branch,
    });
    let made: Value = call(runner, "createWorktree", worktree).await?;
    let done = "completed";
    let mut entries =
        vec![step("git-worktree-completed", "Created worktree", done, started_at, None)];
    if let Some(include) = made.get("worktreeInclude").filter(|include| !include.is_null()) {
        let copied = include.get("copied").and_then(Value::as_i64).unwrap_or(0);
        let skipped = include.get("skipped").and_then(Value::as_i64).unwrap_or(0);
        let kept = if skipped == 0 { String::new() } else { format!(", skipped {skipped}") };
        let text = format!("Copied {copied} file(s) from .worktreeinclude{kept}");
        entries.push(step("worktree-include-completed", &text, done, ctx.now(), None));
    }
    (job.on_progress)(entries);
    let merge_base_branch = string_at(&made, "/mergeBaseBranch");
    let changes = EnvironmentPatch {
        branch_name: Some(Some(branch_name)),
        merge_base_branch: Some(merge_base_branch),
        ..Default::default()
    };
    patch(ctx, &found.id, changes)?;
    string_at(&made, "/path").ok_or_else(|| ApiError::internal("createWorktree returned no path"))
}

async fn materialize(
    ctx: &Ctx,
    found: &Environment,
    runner: &SharedRunner,
    job: &Job,
    base: Option<String>,
) -> ApiResult<String> {
    let id = &found.id;
    check_signal(job)?;
    let creating = EnvironmentPatch {
        status: Some(EnvironmentStatus::Creating),
        status_message: Some(None),
        ..in_use()
    };
    patch(ctx, id, creating)?;
    let key = found.environment_provider_instance_key.clone().unwrap_or_else(|| id.clone());
    let path = if found.environment_provider_id.as_deref() == Some("git-worktree") {
        add_worktree(ctx, found, runner, job, base).await?
    } else {
        let made: Value = call(runner, "ensurePersonalWorkspace", json!({ "key": key })).await?;
        string_at(&made, "/path")
            .ok_or_else(|| ApiError::internal("ensurePersonalWorkspace returned no path"))?
    };
    let provisioning = EnvironmentPatch {
        path: Some(Some(path.clone())),
        status: Some(EnvironmentStatus::Provisioning),
        ..Default::default()
    };
    patch(ctx, id, provisioning)?;
    check_signal(job)?;
    let workspace = Workspace {
        id: id.clone(),
        host_id: found.host_id.clone(),
        project_id: found.project_id.clone(),
        path: path.clone(),
    };
    scripts::setup(ctx, &workspace, &job.on_progress, &job.signal).await?;
    Ok(path)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathInspection {
    exists: bool,
    #[serde(default)]
    branch_name: Option<String>,
    #[serde(default)]
    default_branch: Option<String>,
    #[serde(default)]
    is_git_repo: bool,
    #[serde(default)]
    is_worktree: bool,
}

async fn attach(ctx: &Ctx, found: &Environment, runner: &SharedRunner) -> ApiResult<String> {
    let Some(path) = found.path.clone() else {
        return Err(not_ready("Environment has no workspace."));
    };
    let inspected: PathInspection = call(runner, "inspectPath", json!({ "path": path })).await?;
    if !inspected.exists {
        return Err(not_ready(format!("Directory does not exist: {path}")));
    }
    let observed = EnvironmentPatch {
        branch_name: Some(inspected.branch_name),
        default_branch: Some(inspected.default_branch),
        is_git_repo: Some(inspected.is_git_repo),
        is_worktree: Some(inspected.is_worktree),
        status_message: Some(None),
        ..in_use()
    };
    patch(ctx, &found.id, observed)?;
    Ok(path)
}

async fn prepare_now(
    ctx: &Ctx,
    environment_id: &str,
    job: &Job,
    base: Option<String>,
) -> ApiResult<ThreadEnvironment> {
    let found = require(ctx, environment_id)?;
    let runner = ctx.runners.get(&found.host_id)?;
    if let (EnvironmentStatus::Ready, Some(path)) = (found.status, &found.path) {
        if found.lifecycle.retire_at.is_some() {
            patch(ctx, environment_id, in_use())?;
        }
        let path = path.clone();
        return Ok(ThreadEnvironment { environment_id: environment_id.to_owned(), path });
    }
    let prepared = if found.managed {
        materialize(ctx, &found, &runner, job, base).await
    } else {
        attach(ctx, &found, &runner).await
    };
    match prepared {
        Ok(path) => {
            let ready =
                EnvironmentPatch { status: Some(EnvironmentStatus::Ready), ..Default::default() };
            patch(ctx, environment_id, ready)?;
            Ok(ThreadEnvironment { environment_id: environment_id.to_owned(), path })
        }
        Err(error) => {
            let status_message = if job.signal.is_cancelled() {
                "Workspace setup was cancelled".to_owned()
            } else {
                error_message(&error)
            };
            let failed = EnvironmentPatch {
                status: Some(EnvironmentStatus::Error),
                status_message: Some(Some(status_message)),
                ..Default::default()
            };
            patch(ctx, environment_id, failed)?;
            Err(error)
        }
    }
}

async fn prepare(
    ctx: &Ctx,
    target: &Environment,
    job: &Job,
    base: Option<String>,
) -> ApiResult<ThreadEnvironment> {
    let (ctx, id, job) = (ctx.clone(), target.id.clone(), job.clone());
    let queue = ctx.environments.queue.clone();
    queue.run(&target.id, async move { prepare_now(&ctx, &id, &job, base).await }).await
}

async fn switch_branch(
    ctx: &Ctx,
    prepared: &ThreadEnvironment,
    host_id: &str,
    thread: &ThreadRow,
    branch: &CheckoutBranch,
) -> ApiResult<()> {
    let environment_id = &prepared.environment_id;
    if store::has_other_live_thread(&ctx.db, environment_id, &thread.id)? {
        return Err(not_ready(SHARED_CHECKOUT));
    }
    let (branch_name, create_from) = match branch {
        CheckoutBranch::Existing { name } => (name.clone(), None),
        CheckoutBranch::New { base_branch } => {
            (branch_name_for(ctx, thread)?, Some(base_branch.clone()))
        }
    };
    let runner = ctx.runners.get(host_id)?;
    let wanted =
        json!({ "path": prepared.path, "branchName": branch_name, "createFrom": create_from });
    let switched: Value = call(&runner, "switchBranch", wanted).await?;
    let changes = EnvironmentPatch {
        branch_name: Some(string_at(&switched, "/branchName")),
        ..Default::default()
    };
    patch(ctx, environment_id, changes)?;
    Ok(())
}

async fn attach_checkout(
    ctx: &Ctx,
    job: &Job,
    host_id: &str,
    inputs: CheckoutInputs,
) -> ApiResult<ThreadEnvironment> {
    let thread = &job.thread;
    let project_id = &thread.project_id;
    let path = match inputs.path {
        Some(path) => path,
        None => source_path_of(ctx, project_id, host_id)?,
    };
    let existing = store::find_environment(&ctx.db, AT_PATH, [project_id, host_id, &path])?;
    let target = match &existing {
        Some(found) => found.clone(),
        None => create(
            ctx,
            &NewEnvironment {
                project_id: project_id.clone(),
                host_id: host_id.to_owned(),
                path: Some(path),
                environment_provider_id: "project-checkout".into(),
                owner_thread_id: None,
                instance_key: None,
            },
        )?,
    };
    let prepared = match prepare(ctx, &target, job, None).await {
        Ok(prepared) => prepared,
        Err(error) => {
            if existing.is_none() {
                discard(ctx, &target.id)?;
            }
            return Err(error);
        }
    };
    let Some(branch) = inputs.branch else { return Ok(prepared) };
    if target.managed {
        return Ok(prepared);
    }
    let (ctx2, host_id, thread, prepared2) =
        (ctx.clone(), host_id.to_owned(), thread.clone(), prepared.clone());
    let switching =
        async move { switch_branch(&ctx2, &prepared2, &host_id, &thread, &branch).await };
    ctx.environments.queue.run(&target.id, switching).await?;
    Ok(prepared)
}

async fn default_kind(ctx: &Ctx, project_id: &str, host_id: &str) -> ApiResult<&'static str> {
    let path = source_path_of(ctx, project_id, host_id)?;
    let runner = ctx.runners.get(host_id)?;
    let source: Value = call(&runner, "inspectGitSource", json!({ "path": path })).await?;
    let base = string_at(&source, "/defaultBranch").or(string_at(&source, "/originDefaultBranch"));
    Ok(if base.is_none() { "project-checkout" } else { "git-worktree" })
}

fn parse_inputs<T: DeserializeOwned + Default>(inputs: Option<Value>) -> ApiResult<T> {
    match inputs {
        None | Some(Value::Null) => Ok(T::default()),
        Some(value) => serde_json::from_value(value).map_err(|e| invalid_request(e.to_string())),
    }
}

fn non_empty(path: Option<&String>) -> ApiResult<()> {
    match path {
        Some(path) if path.is_empty() => Err(invalid_request("path must not be empty")),
        _ => Ok(()),
    }
}

impl Default for WorktreeInputs {
    fn default() -> Self {
        Self::Fresh(FreshWorktree::default())
    }
}

pub async fn ensure_for_thread(ctx: &Ctx, job: Job) -> ApiResult<ThreadEnvironment> {
    let (host_id, provider_id, inputs) = match &job.intent {
        EnvironmentIntent::Reuse { environment_id } => {
            return prepare(ctx, &require(ctx, environment_id)?, &job, None).await;
        }
        EnvironmentIntent::Provider { environment_provider_id, host_id, inputs } => {
            (host_id.clone(), environment_provider_id.clone(), inputs.clone())
        }
        EnvironmentIntent::ProjectDefault { host_id } => {
            let kind = default_kind(ctx, &job.thread.project_id, host_id).await?;
            (host_id.clone(), kind.to_owned(), None)
        }
    };
    let owner_thread_id = job.thread.id.clone();
    if provider_id == "project-checkout" {
        let checkout: CheckoutInputs = parse_inputs(inputs)?;
        non_empty(checkout.path.as_ref())?;
        return attach_checkout(ctx, &job, &host_id, checkout).await;
    }
    let worktree = if provider_id == "git-worktree" {
        Some(parse_inputs::<WorktreeInputs>(inputs)?)
    } else {
        None
    };
    let branch = match worktree {
        Some(WorktreeInputs::Existing(existing)) => {
            non_empty(Some(&existing.path))?;
            let checkout = CheckoutInputs { path: Some(existing.path), branch: None };
            return attach_checkout(ctx, &job, &host_id, checkout).await;
        }
        Some(WorktreeInputs::Fresh(fresh)) => Some(fresh.branch),
        None => None,
    };
    let instance_key =
        if branch.is_none() { owner_thread_id.clone() } else { format!("{owner_thread_id}-1") };
    let target = match store::find_environment(&ctx.db, OWNED_BY, [&owner_thread_id])? {
        Some(found) => found,
        None => create(
            ctx,
            &NewEnvironment {
                project_id: job.thread.project_id.clone(),
                host_id,
                path: None,
                environment_provider_id: provider_id,
                owner_thread_id: Some(owner_thread_id),
                instance_key: Some(instance_key),
            },
        )?,
    };
    let base = match branch {
        Some(WorktreeBranch::Named { name }) => Some(name),
        _ => None,
    };
    prepare(ctx, &target, &job, base).await
}

pub fn path_for(ctx: &Ctx, environment_id: &str) -> ApiResult<Option<String>> {
    Ok(store::get_environment(&ctx.db, environment_id)?.and_then(|found| found.path))
}

/// The trimmed workspace instructions file of an environment, when it has one.
pub async fn workspace_instructions(ctx: &Ctx, environment_id: &str) -> Option<String> {
    let found = store::get_environment(&ctx.db, environment_id).ok()??;
    let root_path = found.path?;
    let runner = ctx.runners.get(&found.host_id).ok()?;
    let file = json!({ "path": INSTRUCTIONS_FILE, "rootPath": root_path });
    let read: Value = call(&runner, "readFile", file).await.ok()?;
    if read.get("contentEncoding").and_then(Value::as_str) != Some("utf8") {
        return None;
    }
    let content = read.get("content").and_then(Value::as_str)?;
    let text: String = content.trim().chars().take(INSTRUCTIONS_MAX_LENGTH).collect();
    (!text.is_empty()).then_some(text)
}

fn refresh(ctx: &Ctx, found: Environment) -> ApiResult<Environment> {
    let lifecycle = &found.lifecycle;
    if store::environment_use(&ctx.db, &found.id)?.live > 0 {
        let unmarked = lifecycle.retire_at.is_none() && lifecycle.teardown.is_none();
        return if unmarked { Ok(found) } else { patch(ctx, &found.id, in_use()) };
    }
    let failed = lifecycle.teardown.as_ref().is_some_and(|t| t.status == TeardownStatus::Failed);
    if lifecycle.retire_at.is_some() || failed {
        return Ok(found);
    }
    let retire_at = Some(Some(ctx.now() + RETIRE_GRACE_MS));
    patch(ctx, &found.id, EnvironmentPatch { retire_at, ..Default::default() })
}

fn due(ctx: &Ctx, found: &Environment) -> bool {
    let expired = found.lifecycle.retire_at.is_some_and(|at| at <= ctx.now());
    expired && ctx.runners.is_connected(&found.host_id)
}

async fn remove_managed_path(ctx: &Ctx, found: &Environment) -> ApiResult<()> {
    let Some(path) = found.path.clone().filter(|_| found.managed) else { return Ok(()) };
    let workspace = Workspace {
        id: found.id.clone(),
        host_id: found.host_id.clone(),
        project_id: found.project_id.clone(),
        path: path.clone(),
    };
    scripts::teardown(ctx, &workspace).await?;
    let runner = ctx.runners.get(&found.host_id)?;
    runner.call("removeWorktree", json!({ "path": path })).await?;
    Ok(())
}

async fn teardown(ctx: &Ctx, id: &str, forced: bool) -> ApiResult<()> {
    let Some(found) = store::get_environment(&ctx.db, id)? else { return Ok(()) };
    if found.status == EnvironmentStatus::Destroyed {
        return Ok(());
    }
    if !forced && !due(ctx, &refresh(ctx, found.clone())?) {
        return Ok(());
    }
    let teardown_attempt = found.lifecycle.teardown.as_ref().map_or(0, |t| t.attempt) + 1;
    let running = EnvironmentPatch {
        status: Some(EnvironmentStatus::Error),
        teardown_message: Some(None),
        teardown_status: Some(Some(TeardownStatus::Running)),
        teardown_attempt: Some(teardown_attempt),
        ..Default::default()
    };
    patch(ctx, id, running)?;
    close_terminals_for(ctx, "environment_id", id, "environment-destroyed");
    match remove_managed_path(ctx, &found).await {
        Ok(()) => {
            let removed = EnvironmentPatch {
                status: Some(EnvironmentStatus::Destroyed),
                teardown_status: Some(Some(TeardownStatus::Removed)),
                retire_at: Some(None),
                ..Default::default()
            };
            patch(ctx, id, removed)?;
            Ok(())
        }
        Err(error) => {
            let retries = teardown_attempt < MAX_TEARDOWN_ATTEMPTS;
            let failed = EnvironmentPatch {
                teardown_status: Some(Some(TeardownStatus::Failed)),
                teardown_message: Some(Some(error_message(&error))),
                retire_at: Some(retries.then(|| ctx.now() + TEARDOWN_RETRY_MS)),
                ..Default::default()
            };
            patch(ctx, id, failed)?;
            if forced {
                return Err(error);
            }
            let fields = json!({ "err": error.to_string(), "id": id });
            ctx.log.warn("Environment teardown failed", fields);
            Ok(())
        }
    }
}

pub async fn sweep(ctx: &Ctx) -> ApiResult<()> {
    let mut removals = Vec::new();
    for id in store::list_retirable_environment_ids(&ctx.db)? {
        let found = store::get_environment(&ctx.db, &id)?;
        let Some(found) = found.filter(|_| !ctx.environments.retiring.lock().contains(&id)) else {
            continue;
        };
        if !due(ctx, &refresh(ctx, found)?) {
            continue;
        }
        ctx.environments.retiring.lock().insert(id.clone());
        let (worker, job_id) = (ctx.clone(), id.clone());
        let removal =
            ctx.environments.queue.run(&id, async move { teardown(&worker, &job_id, false).await });
        let ctx = ctx.clone();
        removals.push(async move {
            let result = removal.await;
            ctx.environments.retiring.lock().remove(&id);
            result
        });
    }
    futures::future::join_all(removals).await.into_iter().collect()
}

fn sweep_soon(ctx: &Ctx) {
    let ctx = ctx.clone();
    tokio::spawn(async move {
        if let Err(error) = sweep(&ctx).await {
            ctx.log.error("Environment sweep failed", json!({ "err": error.to_string() }));
        }
    });
}

/// Starts the retirement sweep; the returned guard stops it when dropped.
pub fn start(ctx: &Ctx) -> tokio_util::sync::DropGuard {
    let token = tokio_util::sync::CancellationToken::new();
    let weak: Weak<ServerContext> = Arc::downgrade(ctx);
    let connected = ctx.runners.on_connected(Arc::new(move |_host_id: &str| {
        if let Some(ctx) = weak.upgrade() {
            sweep_soon(&ctx);
        }
    }));
    let (stopped, weak) = (token.clone(), Arc::downgrade(ctx));
    tokio::spawn(async move {
        let _connected = connected;
        let mut interval = tokio::time::interval(SWEEP_INTERVAL);
        loop {
            tokio::select! {
                () = stopped.cancelled() => break,
                _ = interval.tick() => match weak.upgrade() {
                    Some(ctx) => sweep_soon(&ctx),
                    None => break,
                },
            }
        }
    });
    token.drop_guard()
}

fn detach(ctx: &Ctx, thread_id: &str) -> ApiResult<()> {
    let thread = get_thread(&ctx.db, thread_id)?;
    let attached_id = thread.as_ref().and_then(|thread| thread.environment_id.clone());
    let found = match attached_id {
        None => store::find_environment(&ctx.db, OWNED_BY, [thread_id])?,
        Some(id) => store::get_environment(&ctx.db, &id)?,
    };
    let Some(found) = found else { return Ok(()) };
    let deleted = thread.is_some_and(|thread| thread.deleted_at.is_some());
    let orphaned = found.managed
        && found.status != EnvironmentStatus::Destroyed
        && deleted
        && store::environment_use(&ctx.db, &found.id)?.attached == 0;
    if orphaned {
        let retire_at = Some(Some(ctx.now()));
        patch(ctx, &found.id, EnvironmentPatch { retire_at, ..Default::default() })?;
    }
    Ok(())
}

pub fn on_thread_detached(ctx: &Ctx, thread_id: &str) {
    if let Err(error) = detach(ctx, thread_id) {
        let fields = json!({ "err": error.to_string(), "threadId": thread_id });
        ctx.log.error("Environment detach failed", fields);
    }
    sweep_soon(ctx);
}

/// Tears an environment down now and deletes its row when no thread references it.
pub async fn remove(ctx: &Ctx, environment_id: &str) -> ApiResult<()> {
    let (worker, id) = (ctx.clone(), environment_id.to_owned());
    let work = async move { teardown(&worker, &id, true).await };
    ctx.environments.queue.run(environment_id, work).await?;
    let attached = "SELECT 1 FROM threads WHERE environment_id = ?";
    if ctx.db.rows(attached, [environment_id])?.is_empty() {
        discard(ctx, environment_id)?;
    }
    Ok(())
}

pub async fn remove_project_workspaces(ctx: &Ctx, deleted: &DeletedProject) {
    for environment in &deleted.environments {
        let removable =
            environment.provider_owns_path == 1 && ctx.runners.is_connected(&environment.host_id);
        let Some(path) = environment.path.as_ref().filter(|_| removable) else { continue };
        let removed = match ctx.runners.get(&environment.host_id) {
            Ok(runner) => runner
                .call("removeWorktree", json!({ "path": path }))
                .await
                .err()
                .map(|error| error.to_string()),
            Err(error) => Some(error.to_string()),
        };
        if let Some(err) = removed {
            let fields = json!({ "err": err.to_string(), "path": path });
            ctx.log.warn("Could not remove a deleted project's workspace", fields);
        }
    }
}
