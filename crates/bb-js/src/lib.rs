//! An embedded QuickJS runtime on a dedicated thread with a `Send` async handle.

mod engine;
mod node;

pub use node::{NodeCompatOptions, install_node_compat, register_database};

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::mpsc;
use std::time::Duration;

use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::oneshot;

/// A JavaScript exception (or a runtime failure) as seen from Rust.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[error("{name}: {message}")]
pub struct JsError {
    pub name: String,
    pub message: String,
    pub stack: Option<String>,
}

impl JsError {
    pub fn new(name: impl Into<String>, message: impl Into<String>) -> Self {
        Self { name: name.into(), message: message.into(), stack: None }
    }

    pub(crate) fn stopped() -> Self {
        Self::new("Error", "the JavaScript runtime has stopped")
    }
}

/// Console levels: `log`, `info`, `warn`, `error`, `debug`.
pub type ConsoleFn = Arc<dyn Fn(&str, &str) + Send + Sync>;
pub type SyncOp = Arc<dyn Fn(Value) -> Result<Value, String> + Send + Sync>;
pub type AsyncOp = Arc<dyn Fn(Value) -> BoxFuture<'static, Result<Value, String>> + Send + Sync>;

pub struct JsRuntimeOptions {
    /// Heap limit in bytes; `None` is unlimited.
    pub memory_limit: Option<usize>,
    /// Longest a single synchronous run of JavaScript may take before it is interrupted.
    pub deadline: Duration,
    /// Receives `console.*` output; `None` discards it.
    pub console: Option<ConsoleFn>,
    /// Where async ops run; `None` uses the runtime current at construction.
    pub tokio: Option<tokio::runtime::Handle>,
}

impl Default for JsRuntimeOptions {
    fn default() -> Self {
        Self { memory_limit: None, deadline: Duration::from_secs(5), console: None, tokio: None }
    }
}

#[derive(Default)]
pub(crate) struct Registry {
    pub modules: Mutex<HashMap<String, String>>,
    pub sync_ops: Mutex<HashMap<String, SyncOp>>,
    pub async_ops: Mutex<HashMap<String, AsyncOp>>,
}

pub(crate) type Reply = oneshot::Sender<Result<Value, JsError>>;

pub(crate) enum Target {
    Load(String),
    Handler(String),
    Export(String, String),
}

pub(crate) enum Command {
    Call { target: Target, arg: String, reply: Reply },
    OpDone { id: u64, result: Result<Value, String> },
    Shutdown(Option<oneshot::Sender<()>>),
}

struct Inner {
    tx: mpsc::Sender<Command>,
    registry: Arc<Registry>,
}

impl Drop for Inner {
    fn drop(&mut self) {
        let _ = self.tx.send(Command::Shutdown(None));
    }
}

/// Handle to a JavaScript runtime. Cloning shares the runtime; it stops when the last handle drops.
#[derive(Clone)]
pub struct JsRuntime {
    inner: Arc<Inner>,
}

impl JsRuntime {
    /// Starts the engine thread. Must be called inside a tokio runtime unless `options.tokio` is set.
    pub fn new(options: JsRuntimeOptions) -> Result<Self, JsError> {
        let handle = match options.tokio.clone() {
            Some(h) => h,
            None => tokio::runtime::Handle::try_current()
                .map_err(|e| JsError::new("Error", format!("no tokio runtime: {e}")))?,
        };
        let registry = Arc::new(Registry::default());
        let (tx, rx) = mpsc::channel();
        engine::spawn(options, handle, registry.clone(), tx.clone(), rx)?;
        Ok(Self { inner: Arc::new(Inner { tx, registry }) })
    }

    /// Makes `import ... from "<specifier>"` resolve to `source`.
    pub async fn register_module(&self, specifier: &str, source: &str) {
        self.inner.registry.modules.lock().insert(specifier.to_owned(), source.to_owned());
    }

    /// `__bb.op(name, arg)` calls `op`; an `Err` is thrown as an `Error` with that message.
    pub async fn register_sync_op(&self, name: &str, op: SyncOp) {
        self.inner.registry.sync_ops.lock().insert(name.to_owned(), op);
    }

    /// `__bb.opAsync(name, arg)` returns a promise settled by the future, which runs on tokio.
    pub async fn register_async_op(&self, name: &str, op: AsyncOp) {
        self.inner.registry.async_ops.lock().insert(name.to_owned(), op);
    }

    /// Evaluates an ES module named `name` and waits for its top-level evaluation.
    pub async fn load_module(&self, name: &str, source: &str) -> Result<(), JsError> {
        self.register_module(name, source).await;
        self.request(Target::Load(name.to_owned()), Value::Null).await.map(|_| ())
    }

    /// Calls the function registered with `__bb.handle(id, fn)` and awaits its result.
    pub async fn call(&self, id: &str, args: Value) -> Result<Value, JsError> {
        self.request(Target::Handler(id.to_owned()), args).await
    }

    /// Calls the export `export_name` of a module loaded with `load_module`.
    pub async fn call_export(
        &self,
        module: &str,
        export_name: &str,
        args: Value,
    ) -> Result<Value, JsError> {
        self.request(Target::Export(module.to_owned(), export_name.to_owned()), args).await
    }

    /// Stops the engine thread and waits for it to finish; later calls fail.
    pub async fn shutdown(&self) {
        let (reply, done) = oneshot::channel();
        if self.inner.tx.send(Command::Shutdown(Some(reply))).is_ok() {
            let _ = done.await;
        }
    }

    async fn request(&self, target: Target, args: Value) -> Result<Value, JsError> {
        let arg =
            serde_json::to_string(&args).map_err(|e| JsError::new("TypeError", e.to_string()))?;
        let (reply, rx) = oneshot::channel();
        self.inner.tx.send(Command::Call { target, arg, reply }).map_err(|_| JsError::stopped())?;
        rx.await.map_err(|_| JsError::stopped())?
    }
}
