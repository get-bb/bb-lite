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

macro_rules! bundle {
    ($name:literal) => {
        include_str!(concat!(env!("OUT_DIR"), "/plugin-bundles/", $name, ".mjs"))
    };
}

fn plugin_directory(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../plugins").join(name)
}

fn builtin(name: &str, server: BuiltinServer) -> BuiltinPlugin {
    BuiltinPlugin { directory: plugin_directory(name), server }
}

/// In the order of `apps/server/src/plugins/builtin.ts`.
pub fn builtin_plugins() -> Vec<BuiltinPlugin> {
    vec![
        builtin("thread-list", BuiltinServer::Js(bundle!("thread-list"))),
        builtin("navigation", BuiltinServer::None),
        builtin("secrets", BuiltinServer::Js(bundle!("secrets"))),
        builtin("ask-user-question", BuiltinServer::Js(bundle!("ask-user-question"))),
        builtin("custom-instructions", BuiltinServer::Js(bundle!("custom-instructions"))),
        // NATIVE PLUGINS: connect, then account-pool, go here (builtin.ts order).
        builtin("tasks", BuiltinServer::Js(bundle!("tasks"))),
    ]
}
