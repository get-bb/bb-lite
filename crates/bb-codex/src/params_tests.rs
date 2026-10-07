use super::*;
use bb_core::{DynamicTool, ProviderId};

fn options(mode: PermissionMode, escalation: PermissionEscalation) -> ExecutionOptions {
    ExecutionOptions {
        model: "gpt-5.6-sol".into(),
        reasoning_level: ReasoningLevel::Medium,
        service_tier: ServiceTier::Default,
        permission_mode: mode,
        permission_escalation: escalation,
        provider_options: Map::new(),
    }
}

fn client_params(fixture: &str, method: &str) -> Value {
    let path = format!(
        "{}/../../packages/runner/test/fixtures/codex/{fixture}",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = std::fs::read_to_string(path).unwrap();
    text.lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .find(|entry| entry["from"] == "client" && entry["message"]["method"] == method)
        .map(|entry| entry["message"]["params"].clone())
        .unwrap()
}

fn assert_contains(ours: &Value, recorded: &Value, skip: &[&str]) {
    for (key, value) in recorded.as_object().unwrap() {
        if !skip.contains(&key.as_str()) {
            assert_eq!(&ours[key], value, "key {key}");
        }
    }
}

#[test]
fn turn_start_matches_recorded_full_access_turn() {
    let recorded = client_params("turn-tools.wire.ndjson", "turn/start");
    let opts = options(PermissionMode::Full, PermissionEscalation::Ask);
    let input = vec![json!({"type": "text", "text": recorded["input"][0]["text"], "mentions": []})];
    let thread = recorded["threadId"].as_str().unwrap();
    let ours = turn_start_params(thread, &input, &opts, &[]).unwrap();
    assert_contains(&ours, &recorded, &[]);
    let keys: Vec<&String> = ours.as_object().unwrap().keys().collect();
    let expected = [
        "threadId",
        "input",
        "approvalPolicy",
        "approvalsReviewer",
        "sandboxPolicy",
        "model",
        "serviceTier",
        "effort",
    ];
    assert_eq!(keys, expected);
    assert_eq!(ours["serviceTier"], Value::Null);
    assert_eq!(ours["effort"], "medium");
}

#[test]
fn turn_start_matches_recorded_sandboxed_turn() {
    let recorded = client_params("approval-allow.wire.ndjson", "turn/start");
    let opts = options(PermissionMode::AcceptEdits, PermissionEscalation::Ask);
    let roots: Vec<String> =
        serde_json::from_value(recorded["sandboxPolicy"]["writableRoots"].clone()).unwrap();
    let input = vec![json!({"type": "text", "text": recorded["input"][0]["text"]})];
    let ours =
        turn_start_params(recorded["threadId"].as_str().unwrap(), &input, &opts, &roots).unwrap();
    assert_contains(&ours, &recorded, &[]);
}

fn assert_tools_match(ours: &Value, recorded: &Value) {
    let mut tools = ours["dynamicTools"].clone();
    for tool in tools.as_array_mut().unwrap() {
        assert_eq!(tool.as_object_mut().unwrap().shift_remove("type"), Some(json!("function")));
    }
    assert_eq!(tools, recorded["dynamicTools"]);
}

fn spec_from(recorded: &Value) -> (SessionSpec, EnvMap) {
    let config = recorded["config"].as_object().unwrap();
    let prefix = "shell_environment_policy.set.";
    let mut env = EnvMap::new();
    for (key, value) in config {
        if let Some(name) = key.strip_prefix(prefix).filter(|name| *name != "BB_THREAD_ID") {
            env.insert(name.to_owned(), value.as_str().unwrap().to_owned());
        }
    }
    let tools = recorded["dynamicTools"].as_array().unwrap().iter().map(|tool| DynamicTool {
        name: tool["name"].as_str().unwrap().into(),
        description: tool["description"].as_str().unwrap().into(),
        input_schema: tool["inputSchema"].clone(),
        presentation: None,
    });
    let spec = SessionSpec {
        thread_id: config[&format!("{prefix}BB_THREAD_ID")].as_str().unwrap().into(),
        provider_id: ProviderId::Codex,
        cwd: recorded["cwd"].as_str().unwrap().into(),
        provider_thread_id: None,
        instructions: format!("  {}\n", recorded["developerInstructions"].as_str().unwrap()),
        dynamic_tools: tools.collect(),
        env: EnvMap::new(),
        skill_dirs: Vec::new(),
    };
    (spec, env)
}

#[test]
fn thread_start_matches_recorded_sandboxed_start() {
    let recorded = client_params("approval-allow.wire.ndjson", "thread/start");
    let (spec, env) = spec_from(&recorded);
    let opts = options(PermissionMode::AcceptEdits, PermissionEscalation::Ask);
    let roots = vec!["/home/user/.bb-dev/b".to_owned()];
    let roots: Vec<String> =
        match recorded["config"]["sandbox_workspace_write.writable_roots"].clone() {
            Value::Array(list) => {
                list.into_iter().map(|root| root.as_str().unwrap().to_owned()).collect()
            }
            _ => roots,
        };
    let shared = construction_params(&spec, &opts, &env, &roots).unwrap();
    let ours = thread_start_params(shared);
    assert_contains(&ours, &recorded, &["experimentalRawEvents", "dynamicTools"]);
    assert_tools_match(&ours, &recorded);
    let keys: Vec<&String> = ours.as_object().unwrap().keys().collect();
    let expected = [
        "approvalPolicy",
        "approvalsReviewer",
        "sandbox",
        "cwd",
        "developerInstructions",
        "model",
        "serviceTier",
        "config",
        "dynamicTools",
        "ephemeral",
    ];
    assert_eq!(keys, expected);
}

#[test]
fn thread_resume_matches_recorded_resume() {
    let recorded = client_params("resume.wire.ndjson", "thread/resume");
    let (spec, env) = spec_from(&recorded);
    let opts = options(PermissionMode::Full, PermissionEscalation::Ask);
    let shared = construction_params(&spec, &opts, &env, &[]).unwrap();
    let ours = thread_resume_params(recorded["threadId"].as_str().unwrap(), shared);
    assert_contains(&ours, &recorded, &["experimentalRawEvents", "dynamicTools"]);
    assert_tools_match(&ours, &recorded);
    assert_eq!(ours["excludeTurns"], true);
}

#[test]
fn construction_params_without_memory_or_subagents() {
    let mut opts = options(PermissionMode::Auto, PermissionEscalation::Deny);
    opts.model = String::new();
    opts.service_tier = ServiceTier::Fast;
    opts.reasoning_level = ReasoningLevel::Xhigh;
    opts.provider_options = json!({"memoryEnabled": false, "providerSubagentsEnabled": false})
        .as_object()
        .unwrap()
        .clone();
    let spec = SessionSpec {
        thread_id: "thr_1".into(),
        provider_id: ProviderId::Codex,
        cwd: "/w".into(),
        provider_thread_id: None,
        instructions: "  ".into(),
        dynamic_tools: Vec::new(),
        env: EnvMap::new(),
        skill_dirs: Vec::new(),
    };
    let mut env = EnvMap::new();
    env.insert("BB_THREAD_ID".into(), "override".into());
    let roots = vec!["/r".to_owned()];
    let ours = Value::Object(construction_params(&spec, &opts, &env, &roots).unwrap());
    let expected = json!({
        "approvalPolicy": "on-request",
        "approvalsReviewer": "auto_review",
        "sandbox": "workspace-write",
        "cwd": "/w",
        "serviceTier": "fast",
        "config": {
            "shell_environment_policy.set.BB_THREAD_ID": "override",
            "model_reasoning_effort": "xhigh",
            "features.default_mode_request_user_input": false,
            "features.multi_agent": false,
            "features.multi_agent_v2.max_concurrent_threads_per_session": 1,
            "memories.use_memories": false,
            "memories.generate_memories": false,
            "sandbox_workspace_write.writable_roots": ["/r"],
        },
    });
    assert_eq!(ours.to_string(), expected.to_string());
}

#[test]
fn permission_and_effort_mapping() {
    let denied =
        permission_settings(&options(PermissionMode::AcceptEdits, PermissionEscalation::Deny));
    assert_eq!((denied.approval_policy, denied.approvals_reviewer), ("never", "user"));
    let auto = permission_settings(&options(PermissionMode::Auto, PermissionEscalation::Deny));
    assert_eq!((auto.approval_policy, auto.approvals_reviewer), ("on-request", "auto_review"));
    let mut opts = options(PermissionMode::Full, PermissionEscalation::Ask);
    opts.reasoning_level = ReasoningLevel::Ultracode;
    let error = reasoning_effort(&opts).unwrap_err();
    assert_eq!(error.message, "Codex does not support the ultracode reasoning level.");
}

#[test]
fn pool_args_need_url_and_token() {
    let mut env = EnvMap::new();
    env.insert(POOL_URL.into(), "http://127.0.0.1:9/v1".into());
    assert!(pool_args(&env).is_empty());
    env.insert(POOL_TOKEN.into(), "tok".into());
    let args = pool_args(&env);
    assert_eq!(args.len(), 16);
    assert_eq!(args[1], "openai_base_url=\"http://127.0.0.1:9/v1\"");
    let header = "model_providers.bb-account-pool.env_http_headers.x-bb-account-pool-token=\"CODEX_POOL_AUTH_TOKEN\"";
    assert_eq!(args[15], header);
}

#[test]
fn input_chunks_translate() {
    let input = [
        json!({"type": "image", "url": "data:x"}),
        json!({"type": "localFile", "path": "/a.txt"}),
        json!({"type": "skill", "name": "s", "path": "/s"}),
    ];
    let expected = json!([
        {"type": "image", "url": "data:x"},
        {"type": "text", "text": "[Attached file: /a.txt]", "text_elements": []},
        {"type": "skill", "path": "/s"},
    ]);
    assert_eq!(Value::from(to_codex_input(&input)), expected);
}

#[test]
fn command_approval_decodes_and_encodes() {
    let params = json!({
        "turnId": "t", "itemId": "i", "command": "ls", "cwd": "/w",
        "availableDecisions": ["accept", "acceptForSession", "cancel", "decline", {"x": 1}],
        "commandActions": [{"type": "listFiles", "command": "ls", "path": null, "extra": 1}, {"type": "bogus"}],
    });
    let payload = decode_approval("item/commandExecution/requestApproval", &params).unwrap();
    let expected = json!({
        "kind": "approval",
        "reason": null,
        "subject": {
            "kind": "command", "itemId": "i", "command": "ls", "cwd": "/w",
            "actions": [{"type": "listFiles", "command": "ls", "path": null}],
            "sessionGrant": null,
        },
        "availableDecisions": ["allow_once", "deny"],
    });
    assert_eq!(payload.to_string(), expected.to_string());
    let encoded = encode_approval(
        "item/commandExecution/requestApproval",
        &json!({"decision": "allow_for_session"}),
    );
    assert_eq!(encoded, json!({"decision": "acceptForSession"}));
    let missing = decode_approval(
        "item/commandExecution/requestApproval",
        &json!({"turnId": "t", "itemId": "i"}),
    );
    assert_eq!(missing.unwrap_err().message, "Command approval request has no command");
}

#[test]
fn file_change_and_permission_approvals() {
    let params = json!({"turnId": "t", "itemId": "i", "grantRoot": "/w", "reason": "why"});
    let payload = decode_approval(FILE_CHANGE_REQUEST, &params).unwrap();
    assert_eq!(
        payload["subject"]["sessionGrant"],
        json!({"network": null, "fileSystem": {"read": [], "write": ["/w"]}})
    );
    assert_eq!(payload["availableDecisions"], json!(EVERY));
    let params = json!({"turnId": "t", "itemId": "i", "permissions": {"network": {"enabled": true}, "fileSystem": {"read": null, "write": ["/x"]}}});
    let payload = decode_approval(PERMISSIONS_REQUEST, &params).unwrap();
    let permissions =
        json!({"network": {"enabled": true}, "fileSystem": {"read": [], "write": ["/x"]}});
    assert_eq!(payload["subject"]["permissions"], permissions);
    let resolution = json!({"decision": "allow_for_session", "grantedPermissions": {"network": null, "fileSystem": {"read": [], "write": ["/x"]}}});
    let encoded = encode_approval(PERMISSIONS_REQUEST, &resolution);
    assert_eq!(
        encoded,
        json!({"permissions": {"fileSystem": {"read": null, "write": ["/x"]}}, "scope": "session"})
    );
    let denied = encode_approval(PERMISSIONS_REQUEST, &json!({"decision": "deny"}));
    assert_eq!(denied, json!({"permissions": {}, "scope": "turn"}));
}

#[test]
fn models_parse_with_defaults() {
    let result = json!({"data": [
        {"id": "a", "model": "gpt-a", "supportedReasoningEfforts": [{"reasoningEffort": "high"}, {"reasoningEffort": "bogus"}, {"reasoningEffort": "high"}], "defaultReasoningEffort": "low", "isDefault": true},
        {"id": "b", "model": "gpt-b", "displayName": "B", "defaultReasoningEffort": "medium"},
        {"id": "", "model": "skip"},
        {"id": "c", "model": "c", "displayName": ""},
    ]});
    let models = parse_models(&result).unwrap();
    assert_eq!(models.len(), 2);
    assert_eq!(models[0].display_name, "gpt-a");
    assert_eq!(models[0].supported_reasoning_efforts.len(), 1);
    assert_eq!(models[0].default_reasoning_effort, ReasoningLevel::High);
    assert!(models[0].is_default);
    assert_eq!(models[1].supported_reasoning_efforts.len(), 4);
    assert_eq!(models[1].supported_reasoning_efforts[3].description, "Extra high reasoning effort");
    assert_eq!(models[1].default_reasoning_effort, ReasoningLevel::Medium);
    assert!(parse_models(&json!({})).is_err());
}

#[tokio::test]
async fn writable_roots_empty_outside_worktree() {
    let dir = tempfile::tempdir().unwrap();
    assert!(git_writable_roots(dir.path().to_str().unwrap()).await.is_empty());
}
