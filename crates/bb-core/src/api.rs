use std::sync::Arc;

use async_trait::async_trait;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::error::{RunnerError, RunnerResult};
use crate::events::RunnerEvent;

/// Everything a machine can do, as one call: a method name from
/// `RUNNER_METHODS` and its JSON parameters. The local runner, the remote
/// runner link and test fakes all implement this.
#[async_trait]
pub trait RunnerApi: Send + Sync {
    async fn call(&self, method: &str, params: Value) -> RunnerResult<Value>;
}

pub type SharedRunner = Arc<dyn RunnerApi>;
pub type RunnerEventSink = Arc<dyn Fn(RunnerEvent) + Send + Sync>;

pub async fn call_typed<P: Serialize, R: DeserializeOwned>(
    runner: &dyn RunnerApi,
    method: &str,
    params: &P,
) -> RunnerResult<R> {
    let params = serde_json::to_value(params)?;
    let result = runner.call(method, params).await?;
    serde_json::from_value(result).map_err(|error| {
        RunnerError::failed(format!("{method} returned an unexpected result: {error}"))
    })
}

pub const PING_INTERVAL_MS: u64 = 5_000;
pub const LEASE_MS: u64 = 30_000;
const QUICK_MS: u64 = 15_000;
const STANDARD_MS: u64 = 60_000;
const LONG_MS: u64 = 10 * 60_000;
const SCRIPT_GRACE_MS: u64 = 30_000;
const MAX_TIMER_MS: u64 = 2_147_483_647;

pub const RUNNER_METHODS: &[(&str, u64)] = &[
    ("describe", QUICK_MS),
    ("snapshot", QUICK_MS),
    ("ackEvents", QUICK_MS),
    ("listProviders", STANDARD_MS),
    ("listModels", STANDARD_MS),
    ("submitTurn", LONG_MS),
    ("interruptTurn", STANDARD_MS),
    ("releaseSession", STANDARD_MS),
    ("resolveInteraction", QUICK_MS),
    ("resolveToolCall", QUICK_MS),
    ("renameSession", QUICK_MS),
    ("deleteThreadStorage", STANDARD_MS),
    ("inspectPath", STANDARD_MS),
    ("inspectGitSource", STANDARD_MS),
    ("listBranches", STANDARD_MS),
    ("gitStatus", STANDARD_MS),
    ("gitDiffFiles", STANDARD_MS),
    ("gitDiffPatch", STANDARD_MS),
    ("gitDiffFile", STANDARD_MS),
    ("gitCommit", LONG_MS),
    ("createWorktree", LONG_MS),
    ("removeWorktree", LONG_MS),
    ("ensurePersonalWorkspace", LONG_MS),
    ("switchBranch", LONG_MS),
    ("runLifecycleScript", SCRIPT_GRACE_MS),
    ("cancelOperation", QUICK_MS),
    ("readFile", STANDARD_MS),
    ("readFileChunk", STANDARD_MS),
    ("writeFile", STANDARD_MS),
    ("writeFileChunk", STANDARD_MS),
    ("listPaths", STANDARD_MS),
    ("browseDirectory", STANDARD_MS),
    ("pathsExist", QUICK_MS),
    ("mutatePath", STANDARD_MS),
    ("listCommands", STANDARD_MS),
    ("openTerminal", STANDARD_MS),
    ("attachTerminal", QUICK_MS),
    ("writeTerminal", QUICK_MS),
    ("resizeTerminal", QUICK_MS),
    ("closeTerminal", QUICK_MS),
    ("setWatchedPaths", STANDARD_MS),
    ("listOpenTargets", QUICK_MS),
    ("openInTarget", QUICK_MS),
];

pub fn is_runner_method(name: &str) -> bool {
    RUNNER_METHODS.iter().any(|(method, _)| *method == name)
}

pub fn request_timeout_ms(method: &str, params: &Value) -> u64 {
    let base =
        RUNNER_METHODS.iter().find(|(name, _)| *name == method).map_or(STANDARD_MS, |(_, ms)| *ms);
    let own = params.get("timeoutMs").and_then(Value::as_f64).filter(|ms| *ms >= 0.0);
    let extra = if method == "runLifecycleScript" { own.unwrap_or(0.0) as u64 } else { 0 };
    (base + extra).min(MAX_TIMER_MS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn script_timeout_adds_its_own_budget() {
        assert_eq!(
            request_timeout_ms("runLifecycleScript", &json!({"timeoutMs": 900_000})),
            930_000
        );
        assert_eq!(request_timeout_ms("describe", &json!({"timeoutMs": 900_000})), 15_000);
        assert!(is_runner_method("submitTurn"));
        assert!(!is_runner_method("shutdown"));
    }
}
