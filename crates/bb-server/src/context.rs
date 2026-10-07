//! What every server operation receives: configuration, the database, the
//! hub, the connected machines, the plugin host and the in-memory state of
//! the thread engine, the environment manager and the terminals.

use std::sync::Arc;

use crate::config::ServerConfig;
use crate::db::Db;
use crate::environments::manager::EnvironmentsState;
use crate::log::Logger;
use crate::plugins::host::PluginHost;
use crate::runners::registry::RunnerRegistry;
use crate::terminals::sessions::TerminalsState;
use crate::threads::engine::EngineState;
use crate::ws::hub::Hub;

pub struct ServerContext {
    pub config: ServerConfig,
    pub db: Db,
    pub hub: Hub,
    pub runners: RunnerRegistry,
    pub plugins: PluginHost,
    pub log: Logger,
    /// The thread engine's in-memory state; its operations are the functions
    /// of `crate::threads` taking `&Ctx`.
    pub engine: EngineState,
    pub environments: EnvironmentsState,
    pub terminals: TerminalsState,
}

/// Cheap to clone; move a clone into any spawned task.
pub type Ctx = Arc<ServerContext>;

impl ServerContext {
    /// Epoch milliseconds from the database's clock, which tests can fix.
    pub fn now(&self) -> i64 {
        self.db.now()
    }
}
