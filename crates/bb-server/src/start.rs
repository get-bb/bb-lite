//! `startServer`: the production wiring of configuration, providers, the local runner and the
//! server. The CLI owns the process and its signals.

use std::path::PathBuf;
use std::sync::Arc;

use futures::FutureExt;
use tokio_util::sync::CancellationToken;

use crate::config::{ServerEnv, load_config};
use crate::plugins::host::TitleFallback;
use crate::providers::title_service::{ReqwestTitleClient, TitleEndpoints, codex_title};
use crate::runners::local::{LocalRunnerHandle, local_runner_for};
use crate::server::{BbServer, CreateServerOptions, Listening, create_server};

#[derive(Clone, Debug, Default)]
pub struct StartServerOptions {
    pub env: ServerEnv,
    /// Overrides the configured CLI package root.
    pub cli_dir: Option<PathBuf>,
}

pub struct RunningServer {
    pub server: BbServer,
    pub listening: Listening,
    local: LocalRunnerHandle,
}

impl RunningServer {
    /// Closes the server, then stops the local runner.
    pub async fn shutdown(self) {
        self.server.close().await;
        self.local.shutdown().await;
    }
}

fn codex_title_fallback(codex_home: Option<String>) -> TitleFallback {
    let client = Arc::new(ReqwestTitleClient::new());
    let urls = Arc::new(TitleEndpoints::default());
    Arc::new(move |task: String, caller: CancellationToken| {
        let (client, urls, home) = (client.clone(), urls.clone(), codex_home.clone());
        async move {
            let title = codex_title(&task, client.as_ref(), &urls, home.as_deref());
            tokio::select! {
                result = title => result.ok().flatten(),
                () = caller.cancelled() => None,
            }
        }
        .boxed()
    })
}

pub async fn start_server(options: StartServerOptions) -> anyhow::Result<RunningServer> {
    let StartServerOptions { env, cli_dir } = options;
    let mut config = load_config(&env)?;
    if let Some(cli_dir) = cli_dir {
        config.cli_dir = cli_dir;
    }
    let dev = env.get("BB_DEV_PROVIDERS").map_or("", String::as_str);
    let dev: Vec<&str> = dev.split(',').collect();
    let adapters = bb_runner::default_adapters()
        .into_iter()
        .filter(|adapter| adapter.id().as_str() != "echo" || dev.contains(&"echo"))
        .collect();
    let (connect, local) = local_runner_for(&config, adapters);
    let server = create_server(CreateServerOptions::new(config, connect))?;
    let fallback = codex_title_fallback(env.get("CODEX_HOME").cloned());
    server.ctx.plugins.set_title_fallback(Some(fallback));
    let listening = match server.listen().await {
        Ok(listening) => listening,
        Err(error) => {
            server.close().await;
            local.shutdown().await;
            return Err(error);
        }
    };
    let config = &server.ctx.config;
    server.ctx.log.info(
        "bb server listening",
        serde_json::json!({
            "url": listening.url,
            "dataDir": config.data_dir,
            "version": config.version,
        }),
    );
    Ok(RunningServer { server, listening, local })
}
