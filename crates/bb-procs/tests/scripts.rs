mod harness;

use std::time::{Duration, Instant};

use bb_core::{RunnerErrorCode, RunnerEventBody};
use bb_procs::open_targets::{OpenInTargetArgs, OpenTargetKind};
use bb_procs::scripts::{
    CancelOperationArgs, FailureReason, LifecycleScriptResult, RunLifecycleScriptArgs, ScriptKind,
};
use bb_procs::{LifecycleScripts, list_open_targets, open_in_target};
use harness::{Harness, until};

fn script(h: &Harness, name: &str, body: &str) -> String {
    let path = h.path().join(name);
    std::fs::write(&path, body).unwrap();
    path.display().to_string()
}

fn args(
    h: &Harness,
    operation_id: &str,
    kind: ScriptKind,
    timeout_ms: u64,
) -> RunLifecycleScriptArgs {
    let env = [("FROM_ARGS".to_owned(), "yes".to_owned())].into_iter().collect();
    let path = h.path().display().to_string();
    RunLifecycleScriptArgs { operation_id: operation_id.into(), path, kind, timeout_ms, env }
}

fn output(h: &Harness, id: &str) -> String {
    h.bodies()
        .into_iter()
        .filter_map(|(_, body)| match body {
            RunnerEventBody::ScriptOutput { operation_id, text } if operation_id == id => {
                Some(text)
            }
            _ => None,
        })
        .collect()
}

fn failure_of(result: &LifecycleScriptResult) -> (FailureReason, String) {
    let failure = result.failure.clone().expect("a failure");
    (failure.reason, failure.message)
}

#[tokio::test]
async fn streams_output_and_reports_exit_codes() {
    let h = Harness::new();
    let scripts = LifecycleScripts::new(h.ctx.clone());
    let missing = scripts.run(args(&h, "op_0", ScriptKind::Setup, 10_000)).await.unwrap();
    assert_eq!(missing, LifecycleScriptResult { ran: false, exit_code: None, failure: None });

    script(&h, ".bb-env-setup.sh", "echo one\necho \"two $FROM_ARGS\" >&2\nprintf 'x\\rpartial'\n");
    let result = scripts.run(args(&h, "op_1", ScriptKind::Setup, 10_000)).await.unwrap();
    assert_eq!(result, LifecycleScriptResult { ran: true, exit_code: Some(0), failure: None });
    let text = output(&h, "op_1");
    assert!(text.contains("one\n") && text.contains("two yes\n"), "{text:?}");
    assert!(text.contains("partial\n") && !text.contains('x'), "{text:?}");
    let json = serde_json::to_value(&result).unwrap();
    assert_eq!(json, serde_json::json!({"ran": true, "exitCode": 0, "failure": null}));

    let path = script(&h, ".bb-env-teardown.sh", "exit 3\n");
    let result = scripts.run(args(&h, "op_2", ScriptKind::Teardown, 10_000)).await.unwrap();
    assert_eq!(result.exit_code, Some(3));
    let message = format!("Teardown script failed with exit code 3: {path}");
    assert_eq!(failure_of(&result), (FailureReason::Exit, message));
    scripts.dispose().await;
}

#[tokio::test]
async fn times_out_and_kills_the_process_group() {
    let h = Harness::new();
    let scripts = LifecycleScripts::new(h.ctx.clone());
    let path = script(&h, ".bb-env-setup.sh", "echo start\nsleep 30 &\nsleep 30\n");
    let started = Instant::now();
    let result = scripts.run(args(&h, "op_t", ScriptKind::Setup, 300)).await.unwrap();
    assert!(started.elapsed() < Duration::from_secs(10));
    assert!(result.ran && result.exit_code.is_none());
    let message = format!("Setup script timed out after 300ms: {path}");
    assert_eq!(failure_of(&result), (FailureReason::Timeout, message));
    assert_eq!(output(&h, "op_t"), "start\n");
}

#[tokio::test]
async fn cancels_a_running_script_and_one_that_has_not_started() {
    let h = Harness::new();
    let scripts = LifecycleScripts::new(h.ctx.clone());
    script(&h, ".bb-env-setup.sh", "echo start\nsleep 30\n");
    let running = scripts.clone();
    let task = tokio::spawn({
        let args = args(&h, "op_c", ScriptKind::Setup, 60_000);
        async move { running.run(args).await }
    });
    until("script output", || output(&h, "op_c").contains("start").then_some(())).await;
    let cancel = |id: &str| CancelOperationArgs { operation_id: id.into() };
    assert!(scripts.cancel(cancel("op_c")).await.unwrap().cancelled);
    let result = task.await.unwrap().unwrap();
    let expected = (FailureReason::Cancelled, ".bb-env-setup.sh cancelled".to_owned());
    assert_eq!(failure_of(&result), expected);
    assert!(!scripts.cancel(cancel("op_c")).await.unwrap().cancelled);
    let again = scripts.run(args(&h, "op_c", ScriptKind::Setup, 60_000)).await.unwrap();
    assert_eq!(again, result);

    assert!(!scripts.cancel(cancel("op_early")).await.unwrap().cancelled);
    let early = scripts.run(args(&h, "op_early", ScriptKind::Setup, 60_000)).await.unwrap();
    assert!(!early.ran);
    let reason = "Operation was cancelled before it started".to_owned();
    assert_eq!(failure_of(&early), (FailureReason::Cancelled, reason));
}

#[tokio::test]
async fn lists_targets_found_on_path_and_rejects_unknown_ones() {
    let bin = tempfile::tempdir().unwrap();
    for name in ["code", "xdg-open", "not-executable"] {
        let path = bin.path().join(name);
        std::fs::write(&path, "#!/bin/sh\n").unwrap();
        let mode = if name == "not-executable" { 0o644 } else { 0o755 };
        std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(mode))
            .unwrap();
    }
    let env = [("PATH".to_owned(), bin.path().display().to_string())].into_iter().collect();
    let h = Harness::with_env(env);
    let listed = list_open_targets(&h.ctx).await.unwrap();
    let ids: Vec<&str> = listed.targets.iter().map(|target| target.id.as_str()).collect();
    let expected =
        if cfg!(target_os = "macos") { vec!["vscode"] } else { vec!["vscode", "file-manager"] };
    assert_eq!(ids, expected);
    assert_eq!(listed.targets[0].kind, OpenTargetKind::Editor);
    let json = serde_json::to_value(&listed.targets[0]).unwrap();
    let capabilities = serde_json::json!({
        "openDirectory": true, "openFile": true, "openFileAtLine": true, "openFileAtColumn": true
    });
    assert_eq!(json["capabilities"], capabilities);

    let request = |target_id: &str| OpenInTargetArgs {
        target_id: target_id.into(),
        path: h.path().display().to_string(),
        line: None,
        column: None,
    };
    let error = open_in_target(&h.ctx, request("zed")).await.unwrap_err();
    assert_eq!(error.code, RunnerErrorCode::Unavailable);
    assert_eq!(error.message, "Open target is unavailable: zed");
    open_in_target(&h.ctx, request("vscode")).await.unwrap();
}
