use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use parking_lot::Mutex;

use super::*;
use crate::config::ServerConfig;
use crate::db::Db;
use crate::environments::manager::EnvironmentsState;
use crate::log::{LogLevel, Logger};
use crate::plugins::host::{PluginHost, PluginHostOptions};
use crate::runners::registry::RunnerRegistry;
use crate::terminals::sessions::TerminalsState;
use crate::ws::hub::Hub;

fn context(log: Logger) -> Ctx {
    let config = ServerConfig {
        data_dir: PathBuf::from("/nonexistent"),
        port: 0,
        bind_host: "127.0.0.1".into(),
        allowed_hosts: Vec::new(),
        app_dir: PathBuf::from("/nonexistent"),
        cli_dir: PathBuf::from("/nonexistent"),
        bb_cli_path: PathBuf::from("/nonexistent"),
        version: "test".into(),
        host_id: "local".into(),
        log_level: LogLevel::parse("debug").expect("level"),
    };
    let db = Db::open_in_memory(None).expect("database");
    let hub = Hub::new();
    let plugins = PluginHost::new(PluginHostOptions {
        config: config.clone(),
        db: db.clone(),
        hub: hub.clone(),
        log: Logger::silent(),
        builtins: Some(Vec::new()),
    });
    Arc::new(ServerContext {
        config,
        db,
        hub,
        runners: RunnerRegistry::new("local", Logger::silent()),
        plugins,
        log,
        engine: EngineState::default(),
        environments: EnvironmentsState::default(),
        terminals: TerminalsState::default(),
    })
}

#[tokio::test(start_paused = true)]
async fn in_thread_runs_in_call_order_not_poll_order() {
    let ctx = context(Logger::silent());
    let order = Arc::new(Mutex::new(Vec::new()));
    let job = |name: &'static str, wait: u64| {
        let order = order.clone();
        in_thread(&ctx, "t1", async move {
            order.lock().push(format!("{name}:start"));
            tokio::time::sleep(Duration::from_millis(wait)).await;
            order.lock().push(format!("{name}:end"));
        })
    };
    let (first, second) = (job("a", 30), job("b", 1));
    tokio::join!(second, first);
    assert_eq!(*order.lock(), ["a:start", "a:end", "b:start", "b:end"]);
}

#[tokio::test]
async fn commit_releases_follow_ups_only_after_the_transaction() {
    let ctx = context(Logger::silent());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let result = commit(&ctx, |out| {
        let (db, record) = (ctx.db.clone(), seen.clone());
        out.after(move || record.lock().push(db.in_transaction()));
        assert!(seen.lock().is_empty());
        Ok(7)
    });
    assert_eq!(result.expect("committed"), 7);
    assert_eq!(*seen.lock(), [false]);

    let failed: ApiResult<()> = commit(&ctx, |out| {
        let seen = seen.clone();
        out.after(move || seen.lock().push(true));
        Err(ApiError::new(409, "conflict", "no"))
    });
    assert!(failed.is_err());
    assert_eq!(seen.lock().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn settled_waits_for_background_work_and_failures_are_logged() {
    let lines = Arc::new(Mutex::new(Vec::new()));
    let sink = lines.clone();
    let log = Logger::with_writer(LogLevel::parse("debug").expect("level"), move |line| {
        sink.lock().push(line.to_owned());
    });
    let ctx = context(log);
    let done = Arc::new(AtomicBool::new(false));
    let flag = done.clone();
    background(&ctx, "slow", async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        flag.store(true, Ordering::SeqCst);
        Ok(())
    });
    later(&ctx, "t1", "broken", async { Err::<(), _>(ApiError::new(500, "boom", "broken")) });
    settled(&ctx).await;
    assert!(done.load(Ordering::SeqCst));
    let lines = lines.lock();
    assert!(lines.iter().any(|line| line.contains("Thread engine work failed")));
    assert!(lines.iter().any(|line| line.contains("broken")));
}
