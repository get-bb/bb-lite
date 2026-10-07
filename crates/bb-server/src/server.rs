//! `createServer`: builds the server context and runs the HTTP server and the background
//! services until `close`.

use std::any::Any;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context as _;
use parking_lot::Mutex;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::config::{ServerConfig, data_paths};
use crate::context::{Ctx, ServerContext};
use crate::db::projects::ensure_personal_project;
use crate::db::{Db, NowFn};
use crate::domain::changes::HostChangeKind;
use crate::environments::manager;
use crate::environments::watch::start_workspace_watch;
use crate::http::app::create_http_app;
use crate::log::Logger;
use crate::plugins::builtin::BuiltinPlugin;
use crate::plugins::deps::create_plugin_host_deps;
use crate::plugins::host::{PluginHost, PluginHostOptions};
use crate::runners::hosts::ensure_local_host;
use crate::runners::registry::{RunnerFactory, RunnerRegistry};
use crate::terminals::sessions::start_terminal_sessions;
use crate::threads::engine;
use crate::ws::hub::Hub;
use crate::ws::sockets::SocketShutdown;

const SERVE_GRACE: Duration = Duration::from_secs(1);

pub struct CreateServerOptions {
    pub config: ServerConfig,
    pub local_runner: RunnerFactory,
    /// Opened at `data_paths(config.data_dir).database` when absent.
    pub db: Option<Db>,
    pub now: Option<NowFn>,
    pub log: Option<Logger>,
    /// `None` loads `builtin_plugins()`.
    pub builtins: Option<Vec<BuiltinPlugin>>,
}

impl CreateServerOptions {
    pub fn new(config: ServerConfig, local_runner: RunnerFactory) -> Self {
        Self { config, local_runner, db: None, now: None, log: None, builtins: None }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Listening {
    pub port: u16,
    pub url: String,
}

enum Disposer {
    Drop(Box<dyn Any + Send>),
    Engine,
    Plugins,
}

struct Serving {
    stop: CancellationToken,
    task: JoinHandle<std::io::Result<()>>,
}

pub struct BbServer {
    pub ctx: Ctx,
    shutdown: SocketShutdown,
    disposers: Mutex<Vec<Disposer>>,
    serving: Mutex<Option<Serving>>,
}

pub fn create_server(options: CreateServerOptions) -> anyhow::Result<BbServer> {
    let CreateServerOptions { config, local_runner, db, now, log, builtins } = options;
    let log = log.unwrap_or_else(|| Logger::new(config.log_level));
    let db = match db {
        Some(db) => db,
        None => Db::open(&data_paths(&config.data_dir).database, now)?,
    };
    let hub = Hub::new();
    let runners = RunnerRegistry::new(&config.host_id, log.clone());
    runners.connect(&config.host_id, local_runner);
    let connected_hub = hub.clone();
    runners
        .on_connected(Arc::new(move |id: &str| {
            connected_hub.host(id, vec![HostChangeKind::HostConnected]);
        }))
        .forever();
    let disconnected_hub = hub.clone();
    runners
        .on_disconnected(Arc::new(move |id: &str| {
            disconnected_hub.host(id, vec![HostChangeKind::HostDisconnected]);
        }))
        .forever();
    let plugins = PluginHost::new(PluginHostOptions {
        config: config.clone(),
        db: db.clone(),
        hub: hub.clone(),
        log: log.clone(),
        builtins,
    });
    let ctx = Arc::new(ServerContext::new(config, db, hub, runners, plugins, log));
    Ok(BbServer {
        ctx,
        shutdown: SocketShutdown::default(),
        disposers: Mutex::new(Vec::new()),
        serving: Mutex::new(None),
    })
}

impl BbServer {
    fn dispose_on_close(&self, disposer: Disposer) {
        self.disposers.lock().push(disposer);
    }

    /// Starts the background services and serves HTTP on `bind_host:port` (0 picks a port).
    pub async fn listen(&self) -> anyhow::Result<Listening> {
        let ctx = &self.ctx;
        self.dispose_on_close(Disposer::Drop(Box::new(ensure_local_host(ctx)?)));
        ensure_personal_project(&ctx.db)?;
        engine::start(ctx)?;
        self.dispose_on_close(Disposer::Engine);
        self.dispose_on_close(Disposer::Drop(Box::new(manager::start(ctx))));
        ctx.plugins.set_deps(create_plugin_host_deps(ctx));
        ctx.plugins.reload(None).await?;
        self.dispose_on_close(Disposer::Plugins);
        self.dispose_on_close(Disposer::Drop(Box::new(start_terminal_sessions(ctx)?)));
        self.dispose_on_close(Disposer::Drop(Box::new(start_workspace_watch(ctx))));
        let hostname = ctx.config.bind_host.clone();
        let address = format!("{hostname}:{}", ctx.config.port);
        let listener = tokio::net::TcpListener::bind(&address)
            .await
            .with_context(|| format!("Failed to listen on {address}"))?;
        let port = listener.local_addr()?.port();
        let app = create_http_app(ctx, self.shutdown.clone());
        let stop = CancellationToken::new();
        let stopped = stop.clone();
        let task = tokio::spawn(async move {
            axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
                .with_graceful_shutdown(async move { stopped.cancelled().await })
                .await
        });
        *self.serving.lock() = Some(Serving { stop, task });
        let host = if hostname == "0.0.0.0" { "127.0.0.1" } else { hostname.as_str() };
        Ok(Listening { port, url: format!("http://{host}:{port}") })
    }

    /// Says goodbye to open sockets, stops the services in reverse order of starting, then stops
    /// serving (connections still open after a second are dropped).
    pub async fn close(&self) {
        self.shutdown.0.cancel();
        self.ctx.hub.close();
        let disposers = std::mem::take(&mut *self.disposers.lock());
        for disposer in disposers.into_iter().rev() {
            match disposer {
                Disposer::Drop(guard) => drop(guard),
                Disposer::Engine => engine::close(&self.ctx).await,
                Disposer::Plugins => self.ctx.plugins.stop().await,
            }
        }
        let serving = self.serving.lock().take();
        if let Some(Serving { stop, mut task }) = serving {
            stop.cancel();
            if tokio::time::timeout(SERVE_GRACE, &mut task).await.is_err() {
                task.abort();
            }
        }
    }
}
