//! The runner for the server's own machine: the same code a remote machine
//! runs, called in-process.

use std::sync::Arc;

use bb_provider::ProviderAdapter;
use bb_runner::{LocalRunner, LocalRunnerOptions, create_local_runner};
use parking_lot::Mutex;

use super::registry::RunnerFactory;
use crate::config::{ServerConfig, loopback_url};

/// Stops the local runner's sessions, terminals and watchers at shutdown.
#[derive(Clone, Default)]
pub struct LocalRunnerHandle {
    runner: Arc<Mutex<Option<Arc<LocalRunner>>>>,
}

impl LocalRunnerHandle {
    pub async fn shutdown(&self) {
        let runner = self.runner.lock().take();
        if let Some(runner) = runner {
            runner.shutdown().await;
        }
    }
}

pub fn local_runner_for(
    config: &ServerConfig,
    adapters: Vec<Arc<dyn ProviderAdapter>>,
) -> (RunnerFactory, LocalRunnerHandle) {
    let handle = LocalRunnerHandle::default();
    let slot = handle.runner.clone();
    let data_dir = config.data_dir.clone();
    let server_url = loopback_url(config);
    let bb_cli_path = config.bb_cli_path.to_string_lossy().into_owned();
    let connect: RunnerFactory = Box::new(move |sink| {
        let options = LocalRunnerOptions { data_dir, server_url, bb_cli_path, sink, adapters };
        let runner = Arc::new(create_local_runner(options));
        *slot.lock() = Some(runner.clone());
        runner
    });
    (connect, handle)
}
