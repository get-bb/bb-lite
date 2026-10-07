//! The plugins compiled into the server.

use std::path::PathBuf;
use std::sync::Arc;

use super::api::NativePlugin;

#[derive(Clone)]
pub enum BuiltinServer {
    /// No server half.
    None,
    /// Written in Rust.
    Native(Arc<dyn NativePlugin>),
    /// A TypeScript server entry bundled to one ES module, run in QuickJS.
    Js(&'static str),
}

#[derive(Clone)]
pub struct BuiltinPlugin {
    /// The plugin directory in the repository: `package.json` (manifest) and skills.
    pub directory: PathBuf,
    pub server: BuiltinServer,
}

pub fn builtin_plugins() -> Vec<BuiltinPlugin> {
    Vec::new()
}
