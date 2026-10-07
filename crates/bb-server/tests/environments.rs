#![allow(clippy::result_large_err)]

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use async_trait::async_trait;
use bb_core::{RunnerApi, RunnerError, RunnerEvent, RunnerEventBody, RunnerEventSink};
use bb_core::{RunnerResult, SharedRunner};
use bb_server::config::ServerConfig;
use bb_server::context::{Ctx, ServerContext};
use bb_server::db::environments::*;
use bb_server::db::threads::get_thread;
use bb_server::db::{Db, params};
use bb_server::domain::environment::{EnvironmentStatus, TeardownStatus};
use bb_server::environments::manager::{self, managed_branch_name};
use bb_server::environments::types::{
    EnsureEnvironmentArgs, EnvironmentIntent, ProgressSink, ThreadEnvironment,
};
use bb_server::error::ApiResult;
use bb_server::log::{LogLevel, Logger};
use bb_server::plugins::host::{PluginHost, PluginHostOptions};
use bb_server::runners::registry::RunnerRegistry;
use bb_server::ws::hub::Hub;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

const HOST: &str = "host_a";
const GRACE_MS: i64 = 5 * 60_000;

type Answer = Box<dyn Fn(&str, &Value) -> RunnerResult<Value> + Send + Sync>;

struct Fake {
    calls: Mutex<Vec<(String, Value)>>,
    answer: Mutex<Answer>,
    sink: Mutex<Option<RunnerEventSink>>,
    script_lines: Mutex<Option<String>>,
    hang_script: Mutex<bool>,
    cancelled: Notify,
}

#[async_trait]
impl RunnerApi for Fake {
    async fn call(&self, method: &str, params: Value) -> RunnerResult<Value> {
        self.calls.lock().push((method.to_owned(), params.clone()));
        if method == "cancelOperation" {
            self.cancelled.notify_one();
        }
        if method == "runLifecycleScript" {
            let operation_id = params["operationId"].as_str().unwrap_or_default().to_owned();
            let text = self.script_lines.lock().clone();
            let sink = self.sink.lock().clone();
            if let (Some(text), Some(sink)) = (text, sink) {
                sink(RunnerEvent::unsequenced(RunnerEventBody::ScriptOutput {
                    operation_id,
                    text,
                }));
                for _ in 0..10 {
                    tokio::task::yield_now().await;
                }
            }
            let hang = *self.hang_script.lock();
            if hang {
                self.cancelled.notified().await;
                let failure = json!({ "reason": "cancelled", "message": "Script was cancelled" });
                return Ok(json!({ "ran": true, "exitCode": null, "failure": failure }));
            }
        }
        (self.answer.lock())(method, &params)
    }
}

fn standard(method: &str, params: &Value) -> RunnerResult<Value> {
    Ok(match method {
        "inspectGitSource" => json!({ "defaultBranch": "main", "originDefaultBranch": null }),
        "createWorktree" => json!({
            "path": format!("/data/worktrees/{}/repo", params["key"].as_str().unwrap_or("")),
            "branchName": params["branchName"], "mergeBaseBranch": "origin/main",
            "worktreeInclude": { "copied": 2, "skipped": 1 },
        }),
        "ensurePersonalWorkspace" => {
            json!({ "path": format!("/data/workspaces/{}", params["key"].as_str().unwrap_or("")) })
        }
        "inspectPath" => json!({
            "exists": true, "branchName": "main", "defaultBranch": "main",
            "isGitRepo": true, "isWorktree": false,
        }),
        "switchBranch" => json!({ "branchName": params["branchName"] }),
        "pathsExist" => {
            let paths = params["paths"].as_array().cloned().unwrap_or_default();
            let map: serde_json::Map<String, Value> = paths
                .iter()
                .filter_map(Value::as_str)
                .map(|p| (p.to_owned(), json!(true)))
                .collect();
            json!({ "existence": map })
        }
        "runLifecycleScript" => json!({ "ran": true, "exitCode": 0, "failure": null }),
        "listBranches" => json!({ "selectedBranch": { "kind": "local" } }),
        "readFile" => json!({ "contentEncoding": "utf8", "content": "  Use pnpm.\n" }),
        _ => Value::Null,
    })
}

struct World {
    ctx: Ctx,
    fake: Arc<Fake>,
    clock: Arc<AtomicI64>,
    progress: Arc<Mutex<Vec<Value>>>,
}

impl World {
    fn new(has_source: bool) -> Self {
        let clock = Arc::new(AtomicI64::new(1_000));
        let now = clock.clone();
        let db = Db::open_in_memory(Some(Arc::new(move || now.load(Ordering::SeqCst)))).unwrap();
        db.run(
            "INSERT INTO hosts (id, name, created_at, updated_at) VALUES (?, 'a', 1, 1)",
            [HOST],
        )
        .unwrap();
        db.run(
            "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('prj', 'demo', 1, 1)",
            [],
        )
        .unwrap();
        if has_source {
            let sql = "INSERT INTO project_sources (id, project_id, host_id, path, is_default,
              created_at, updated_at) VALUES ('src', 'prj', ?, '/repo', 1, 1, 1)";
            db.run(sql, [HOST]).unwrap();
        }
        let config = ServerConfig {
            data_dir: PathBuf::from("/nonexistent-bb-test"),
            port: 0,
            bind_host: "127.0.0.1".into(),
            allowed_hosts: vec![],
            app_dir: PathBuf::new(),
            cli_dir: PathBuf::new(),
            bb_cli_path: PathBuf::new(),
            version: "test".into(),
            host_id: HOST.into(),
            log_level: LogLevel::Warn,
        };
        let hub = Hub::new();
        let log = Logger::silent();
        let plugins = PluginHost::new(PluginHostOptions {
            config: config.clone(),
            db: db.clone(),
            hub: hub.clone(),
            log: log.clone(),
            builtins: Some(vec![]),
        });
        let ctx = Arc::new(ServerContext {
            config,
            db,
            hub,
            runners: RunnerRegistry::new(HOST, log.clone()),
            plugins,
            log,
            engine: Default::default(),
            environments: Default::default(),
            terminals: Default::default(),
        });
        let fake = Arc::new(Fake {
            calls: Mutex::default(),
            answer: Mutex::new(Box::new(standard)),
            sink: Mutex::default(),
            script_lines: Mutex::default(),
            hang_script: Mutex::new(false),
            cancelled: Notify::new(),
        });
        let runner = fake.clone();
        ctx.runners.connect(
            HOST,
            Box::new(move |sink| {
                *runner.sink.lock() = Some(sink);
                runner as SharedRunner
            }),
        );
        Self { ctx, fake, clock, progress: Arc::default() }
    }

    fn thread(&self, id: &str, environment_id: Option<&str>) {
        let sql = "INSERT INTO threads (id, project_id, environment_id, provider_id, status, title,
          latest_attention_at, created_at, updated_at)
          VALUES (?, 'prj', ?, 'echo', 'idle', 'Build the widget', 1, 1, 1)";
        self.ctx.db.run(sql, params![id, environment_id]).unwrap();
    }

    fn set(&self, sql: &str, id: &str) {
        self.ctx.db.run(sql, [id]).unwrap();
    }

    fn job(&self, thread_id: &str, intent: EnvironmentIntent) -> EnsureEnvironmentArgs {
        let progress = self.progress.clone();
        let on_progress: ProgressSink = Arc::new(move |entries| progress.lock().extend(entries));
        let thread = get_thread(&self.ctx.db, thread_id).unwrap().unwrap();
        EnsureEnvironmentArgs { thread, intent, on_progress, signal: CancellationToken::new() }
    }

    async fn ensure(
        &self,
        thread_id: &str,
        intent: EnvironmentIntent,
    ) -> ApiResult<ThreadEnvironment> {
        manager::ensure_for_thread(&self.ctx, self.job(thread_id, intent)).await
    }

    fn methods(&self) -> Vec<String> {
        self.fake.calls.lock().iter().map(|(method, _)| method.clone()).collect()
    }

    fn count(&self, method: &str) -> usize {
        self.methods().iter().filter(|m| *m == method).count()
    }

    fn env(&self, id: &str) -> bb_server::domain::environment::Environment {
        get_environment(&self.ctx.db, id).unwrap().unwrap()
    }

    fn texts(&self) -> Vec<String> {
        let entries = self.progress.lock();
        entries.iter().filter_map(|e| e["text"].as_str().map(str::to_owned)).collect()
    }

    fn status_message(&self, id: &str) -> Option<String> {
        let rows = self.ctx.db.rows("SELECT status_message FROM environments WHERE id = ?", [id]);
        rows.unwrap()[0]["statusMessage"].as_str().map(str::to_owned)
    }

    fn advance(&self, ms: i64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }
}

fn project_default() -> EnvironmentIntent {
    EnvironmentIntent::ProjectDefault { host_id: HOST.into() }
}

fn checkout(inputs: Value) -> EnvironmentIntent {
    let environment_provider_id = "project-checkout".into();
    EnvironmentIntent::Provider {
        environment_provider_id,
        host_id: HOST.into(),
        inputs: Some(inputs),
    }
}

fn reuse(environment_id: &str) -> EnvironmentIntent {
    EnvironmentIntent::Reuse { environment_id: environment_id.into() }
}

#[tokio::test]
async fn names_managed_branches_from_the_title() {
    let world = World::new(true);
    world.thread("thr_1", None);
    let mut thread = get_thread(&world.ctx.db, "thr_1").unwrap().unwrap();
    assert_eq!(managed_branch_name("bb/", &thread), "bb/build-the-widget-thr_1");
    thread.thread.title = Some("  ### Fix: ünïcode & stuff!! ".into());
    assert_eq!(managed_branch_name("bb/", &thread), "bb/fix-n-code-stuff-thr_1");
    thread.thread.title = Some("!!!".into());
    assert_eq!(managed_branch_name("x-", &thread), "x-thr_1");
}

#[tokio::test]
async fn project_default_creates_a_managed_worktree_and_runs_setup() {
    let world = World::new(true);
    world.thread("thr_1", None);
    *world.fake.script_lines.lock() = Some("setting up repo\nsecond\n".into());
    let made = world.ensure("thr_1", project_default()).await.unwrap();
    assert_eq!(made.path, "/data/worktrees/thr_1-1/repo");
    let found = world.env(&made.environment_id);
    assert_eq!(found.status, EnvironmentStatus::Ready);
    assert_eq!(found.branch_name.as_deref(), Some("bb/build-the-widget-thr_1"));
    assert_eq!(found.merge_base_branch.as_deref(), Some("origin/main"));
    assert_eq!(found.environment_provider_id.as_deref(), Some("git-worktree"));
    assert!(found.managed);
    let expected = [
        "Creating worktree",
        "Created worktree",
        "Copied 2 file(s) from .worktreeinclude, skipped 1",
        "Running .bb-env-setup.sh",
        "setting up repo",
        "second",
        ".bb-env-setup.sh finished",
    ];
    assert_eq!(world.texts(), expected);
    let script = world.fake.calls.lock().iter().find(|(m, _)| m == "runLifecycleScript").cloned();
    let (_, script) = script.unwrap();
    assert_eq!(script["kind"], "setup");
    assert_eq!(script["timeoutMs"], 15 * 60_000);
    assert_eq!(script["path"], "/data/worktrees/thr_1-1/repo");
    let again = world.ensure("thr_1", reuse(&made.environment_id)).await.unwrap();
    assert_eq!(again, made);
    assert_eq!(world.count("createWorktree"), 1);
    let instructions = manager::workspace_instructions(&world.ctx, &made.environment_id).await;
    assert_eq!(instructions.as_deref(), Some("Use pnpm."));
    assert_eq!(manager::path_for(&world.ctx, &made.environment_id).unwrap(), Some(made.path));
}

#[tokio::test]
async fn project_default_attaches_the_checkout_without_a_default_branch() {
    let world = World::new(true);
    world.thread("thr_1", None);
    *world.fake.answer.lock() = Box::new(|method, params| match method {
        "inspectGitSource" => Ok(json!({ "defaultBranch": null, "originDefaultBranch": null })),
        _ => standard(method, params),
    });
    let made = world.ensure("thr_1", project_default()).await.unwrap();
    assert_eq!(made.path, "/repo");
    let found = world.env(&made.environment_id);
    assert_eq!(found.environment_provider_id.as_deref(), Some("project-checkout"));
    assert!(!found.managed);
    assert_eq!(found.status, EnvironmentStatus::Ready);
    assert_eq!(world.count("runLifecycleScript"), 0);
}

#[tokio::test]
async fn a_failed_setup_leaves_the_environment_in_error_and_retries_in_place() {
    let world = World::new(true);
    world.thread("thr_1", None);
    *world.fake.answer.lock() = Box::new(|method, params| match method {
        "runLifecycleScript" => {
            let failure =
                json!({ "reason": "exit", "message": "Setup script failed with exit code 3" });
            Ok(json!({ "ran": true, "exitCode": 3, "failure": failure }))
        }
        _ => standard(method, params),
    });
    let error = world.ensure("thr_1", project_default()).await.unwrap_err();
    assert_eq!(error.code(), "environment_not_ready");
    assert_eq!(error.to_string(), "Setup script failed with exit code 3");
    let ids = list_retirable_environment_ids(&world.ctx.db).unwrap();
    let failed = world.env(&ids[0]);
    assert_eq!(failed.status, EnvironmentStatus::Error);
    assert_eq!(
        world.status_message(&failed.id).as_deref(),
        Some("Setup script failed with exit code 3")
    );
    assert!(world.texts().contains(&".bb-env-setup.sh failed".to_owned()));
    *world.fake.answer.lock() = Box::new(standard);
    let made = world.ensure("thr_1", project_default()).await.unwrap();
    assert_eq!(made.environment_id, failed.id);
    assert_eq!(world.env(&failed.id).status, EnvironmentStatus::Ready);
}

#[tokio::test]
async fn cancelling_the_signal_cancels_a_running_setup_script() {
    let world = World::new(true);
    world.thread("thr_1", None);
    *world.fake.hang_script.lock() = true;
    let job = world.job("thr_1", project_default());
    let signal = job.signal.clone();
    let ctx = world.ctx.clone();
    let running = tokio::spawn(async move { manager::ensure_for_thread(&ctx, job).await });
    while world.count("runLifecycleScript") == 0 {
        tokio::task::yield_now().await;
    }
    signal.cancel();
    let error = running.await.unwrap().unwrap_err();
    assert_eq!(error.to_string(), "Workspace setup was cancelled");
    assert_eq!(world.count("cancelOperation"), 1);
    let ids = list_retirable_environment_ids(&world.ctx.db).unwrap();
    let found = world.env(&ids[0]);
    assert_eq!(found.status, EnvironmentStatus::Error);
    assert_eq!(world.status_message(&found.id).as_deref(), Some("Workspace setup was cancelled"));
}

#[tokio::test]
async fn refuses_a_branch_switch_while_another_thread_uses_the_checkout() {
    let world = World::new(true);
    world.thread("thr_1", None);
    let new = json!({ "branch": { "kind": "new", "baseBranch": "main" } });
    let topic = world.ensure("thr_1", checkout(new)).await.unwrap();
    assert_eq!(
        world.env(&topic.environment_id).branch_name.as_deref(),
        Some("bb/build-the-widget-thr_1")
    );
    world.set("UPDATE threads SET environment_id = ? WHERE id = 'thr_1'", &topic.environment_id);
    world.thread("thr_2", None);
    let main = json!({ "branch": { "kind": "existing", "name": "main" } });
    let error = world.ensure("thr_2", checkout(main.clone())).await.unwrap_err();
    assert_eq!(
        error.to_string(),
        "Cannot checkout branch while another thread is using this workspace"
    );
    assert_eq!(world.count("switchBranch"), 1);
    world.set("UPDATE threads SET archived_at = 5 WHERE id = ?", "thr_1");
    world.ensure("thr_2", checkout(main)).await.unwrap();
    assert_eq!(world.count("switchBranch"), 2);
    assert_eq!(world.env(&topic.environment_id).branch_name.as_deref(), Some("main"));
}

#[tokio::test]
async fn a_new_checkout_row_is_discarded_when_attaching_fails() {
    let world = World::new(true);
    world.thread("thr_1", None);
    *world.fake.answer.lock() = Box::new(|method, params| match method {
        "inspectPath" => Ok(json!({ "exists": false })),
        _ => standard(method, params),
    });
    let error = world.ensure("thr_1", checkout(json!({ "path": "/gone" }))).await.unwrap_err();
    assert_eq!(error.to_string(), "Directory does not exist: /gone");
    let rows = world.ctx.db.rows("SELECT id FROM environments", []).unwrap();
    assert!(rows.is_empty());
}

#[tokio::test]
async fn restores_a_destroyed_worktree_on_its_branch() {
    let world = World::new(true);
    world.thread("thr_1", None);
    let made = world.ensure("thr_1", project_default()).await.unwrap();
    let id = &made.environment_id;
    world.set("UPDATE environments SET status = 'destroyed' WHERE id = ?", id);
    let restored = world.ensure("thr_1", reuse(id)).await.unwrap();
    assert_eq!(restored, made);
    assert_eq!(world.env(id).status, EnvironmentStatus::Ready);
    assert_eq!(world.count("createWorktree"), 2);
    let calls = world.fake.calls.lock().clone();
    let (_, second) = calls.iter().filter(|(m, _)| m == "createWorktree").nth(1).unwrap();
    assert_eq!(second["branchName"], "bb/build-the-widget-thr_1");
    assert_eq!(second["baseBranch"], "origin/main");
    world.set("UPDATE environments SET status = 'destroyed' WHERE id = ?", id);
    *world.fake.answer.lock() = Box::new(|method, params| match method {
        "listBranches" => Ok(json!({ "selectedBranch": null })),
        _ => standard(method, params),
    });
    let error = world.ensure("thr_1", reuse(id)).await.unwrap_err();
    let gone =
        "Branch bb/build-the-widget-thr_1 no longer exists, so its worktree cannot be restored.";
    assert_eq!(error.to_string(), gone);
}

async fn worktree_for(world: &World, thread_id: &str) -> String {
    world.thread(thread_id, None);
    let made = world.ensure(thread_id, project_default()).await.unwrap();
    let sql = "UPDATE threads SET environment_id = ? WHERE id = ?";
    world.ctx.db.run(sql, params![made.environment_id, thread_id]).unwrap();
    made.environment_id
}

#[tokio::test]
async fn retires_an_unused_worktree_after_the_grace_period() {
    let world = World::new(true);
    let id = worktree_for(&world, "thr_1").await;
    manager::sweep(&world.ctx).await.unwrap();
    assert_eq!(world.env(&id).lifecycle.retire_at, None);
    world.set("UPDATE threads SET archived_at = 5 WHERE id = ?", "thr_1");
    manager::sweep(&world.ctx).await.unwrap();
    assert_eq!(world.env(&id).lifecycle.retire_at, Some(1_000 + GRACE_MS));
    world.set("UPDATE threads SET archived_at = NULL WHERE id = ?", "thr_1");
    manager::sweep(&world.ctx).await.unwrap();
    assert_eq!(world.env(&id).lifecycle.retire_at, None);
    world.set("UPDATE threads SET archived_at = 5 WHERE id = ?", "thr_1");
    manager::sweep(&world.ctx).await.unwrap();
    world.advance(GRACE_MS);
    manager::sweep(&world.ctx).await.unwrap();
    let found = world.env(&id);
    assert_eq!(found.status, EnvironmentStatus::Destroyed);
    assert_eq!(found.lifecycle.teardown.map(|t| t.status), Some(TeardownStatus::Removed));
    let methods = world.methods();
    let tail: Vec<&str> = methods.iter().rev().take(2).rev().map(String::as_str).collect();
    assert_eq!(tail, ["runLifecycleScript", "removeWorktree"]);
}

#[tokio::test]
async fn retries_a_failed_teardown_five_times_in_all() {
    let world = World::new(true);
    let id = worktree_for(&world, "thr_1").await;
    *world.fake.answer.lock() = Box::new(|method, params| match method {
        "removeWorktree" => Err(RunnerError::failed("busy")),
        _ => standard(method, params),
    });
    world.set("UPDATE threads SET archived_at = 5 WHERE id = ?", "thr_1");
    world.set("UPDATE environments SET retire_at = 0 WHERE id = ?", &id);
    for attempt in 1..=5 {
        manager::sweep(&world.ctx).await.unwrap();
        let teardown = world.env(&id).lifecycle.teardown.unwrap();
        assert_eq!((teardown.status, teardown.attempt), (TeardownStatus::Failed, attempt));
        assert_eq!(teardown.message.as_deref(), Some("busy"));
        let retry = (attempt < 5).then(|| world.ctx.now() + 60_000);
        assert_eq!(world.env(&id).lifecycle.retire_at, retry);
        world.advance(60_000);
    }
    manager::sweep(&world.ctx).await.unwrap();
    assert_eq!(world.count("removeWorktree"), 5);
}

#[tokio::test]
async fn retires_at_once_when_the_last_thread_is_deleted() {
    let world = World::new(true);
    let id = worktree_for(&world, "thr_1").await;
    world.set("UPDATE threads SET deleted_at = 5, environment_id = NULL WHERE id = ?", "thr_1");
    manager::on_thread_detached(&world.ctx, "thr_1");
    assert_eq!(world.env(&id).lifecycle.retire_at, Some(1_000));
    manager::sweep(&world.ctx).await.unwrap();
    assert_eq!(world.env(&id).status, EnvironmentStatus::Destroyed);
}

#[tokio::test]
async fn remove_deletes_the_row_only_when_unreferenced() {
    let world = World::new(true);
    let kept = worktree_for(&world, "thr_1").await;
    world.set("UPDATE threads SET archived_at = 5 WHERE id = ?", "thr_1");
    manager::remove(&world.ctx, &kept).await.unwrap();
    assert_eq!(world.env(&kept).status, EnvironmentStatus::Destroyed);
    world.thread("thr_2", None);
    let gone = world.ensure("thr_2", project_default()).await.unwrap().environment_id;
    manager::remove(&world.ctx, &gone).await.unwrap();
    assert!(get_environment(&world.ctx.db, &gone).unwrap().is_none());
}
