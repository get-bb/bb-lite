#![allow(dead_code)]

use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use bb_core::env::{EnvMap, fixed_env, process_env};
use bb_core::exec::{Ctx, KeyedLock};
use bb_core::{RunnerError, RunnerErrorCode, RunnerEvent, RunnerEventBody};
use parking_lot::Mutex;

pub struct Harness {
    pub root: tempfile::TempDir,
    pub ctx: Ctx,
    pub events: Arc<Mutex<Vec<RunnerEvent>>>,
}

impl Harness {
    pub fn new() -> Self {
        Self::with_env(process_env())
    }

    pub fn with_env(env: EnvMap) -> Self {
        let root = tempfile::tempdir().unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let recorded = events.clone();
        let ctx = Ctx {
            data_dir: root.path().join("data"),
            sink: Arc::new(move |event| recorded.lock().push(event)),
            env: fixed_env(env),
            lock: KeyedLock::new(),
        };
        Self { root, ctx, events }
    }

    pub fn path(&self) -> &Path {
        self.root.path()
    }

    pub fn bodies(&self) -> Vec<(Option<u64>, RunnerEventBody)> {
        self.events.lock().iter().map(|event| (event.seq, event.body.clone())).collect()
    }
}

pub async fn until<T>(what: &str, mut check: impl FnMut() -> Option<T>) -> T {
    for _ in 0..500 {
        if let Some(found) = check() {
            return found;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("timed out waiting for {what}");
}

pub async fn failure_code<T>(
    work: impl Future<Output = Result<T, RunnerError>>,
) -> RunnerErrorCode {
    match work.await {
        Ok(_) => panic!("expected a failure"),
        Err(error) => error.code,
    }
}
