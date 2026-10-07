mod engine_e2e_lifecycle_support;
mod http_e2e_support;

use std::sync::Arc;

use bb_core::RunnerEventSink;
use bb_server::threads::engine;
use engine_e2e_lifecycle_support::{Fake, Script, default_script};
use http_e2e_support::{BootOptions, boot_with};
use parking_lot::Mutex;
use reqwest::StatusCode;
use serde_json::{Value, json};

#[tokio::test]
async fn a_custom_model_is_offered_and_its_environment_reaches_the_session() {
    let mut script = default_script();
    let models = json!({ "models": [{ "model": "gpt-test" }], "selectedOnlyModels": [] });
    script.insert("listModels".to_owned(), Arc::new(move |_: &Value| Ok(models.clone())));
    let workspace: Script = Arc::new(|params: &Value| {
        Ok(json!({ "path": format!("/workspaces/{}", params["key"].as_str().unwrap_or_default()) }))
    });
    script.insert("ensurePersonalWorkspace".to_owned(), workspace);
    let fake = Arc::new(Fake { script: Mutex::new(script), ..Default::default() });
    let sink: Arc<Mutex<Option<RunnerEventSink>>> = Arc::default();
    let (connected, runner) = (sink.clone(), fake.clone());
    let preview = json!({
        "providerId": "codex",
        "model": "gpt-preview",
        "displayName": "Preview",
        "description": "Early access",
        "env": { "PREVIEW_CONFIG_URL": "https://example.test/config.json" },
        "unsetEnv": ["MAX_OUTPUT_TOKENS"],
    });
    let options = BootOptions {
        runner: Some(Box::new(move |events| {
            *sink.lock() = Some(events);
            runner
        })),
        config_json: Some(json!({ "customModels": [
            preview,
            { "providerId": "codex", "model": "gpt-plain" },
            { "providerId": "claude-code", "model": "claude-other", "env": { "A": "1" } },
        ]})),
        ..Default::default()
    };
    let server = boot_with(options).await;
    server.wait_until("runner connected", || connected.lock().is_some()).await;

    let (status, options) = server.get("/system/execution-options?providerId=codex").await;
    assert_eq!(status, StatusCode::OK, "{options}");
    let offered = |model: &str| {
        let models = options["models"].as_array().unwrap();
        models.iter().find(|entry| entry["model"] == model).cloned().unwrap_or(Value::Null)
    };
    assert_eq!(
        json!([offered("gpt-preview")["displayName"], offered("gpt-preview")["description"]]),
        json!(["Preview", "Early access"]),
    );
    assert_eq!(offered("gpt-plain")["description"], "Custom model from config.json");

    server
        .create_thread(json!({
            "projectId": "proj_personal",
            "origin": "app",
            "providerId": "codex",
            "model": "gpt-preview",
            "input": [{ "type": "text", "text": "hello", "mentions": [] }],
            "environment": { "type": "project-default" },
            "startedOnBehalfOf": null,
        }))
        .await;
    engine::settled(&server.server.ctx).await;
    let submitted = fake.submitted.lock().clone();
    assert_eq!(submitted.len(), 1);
    assert_eq!(
        submitted[0]["session"]["customModels"],
        json!([{
            "model": "gpt-preview",
            "env": { "PREVIEW_CONFIG_URL": "https://example.test/config.json" },
            "unsetEnv": ["MAX_OUTPUT_TOKENS"],
        }]),
    );
}
