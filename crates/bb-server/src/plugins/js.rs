//! The QuickJS bridge for TypeScript plugin server halves.

use super::api::PluginResult;
use super::instance::PluginApi;

pub async fn start_js_plugin(_source: &str, _api: PluginApi) -> PluginResult<()> {
    todo!("QuickJS plugin bridge")
}
