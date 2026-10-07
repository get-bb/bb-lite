use std::path::{Path, PathBuf};
use std::sync::Arc;

use bb_claude::options::*;
use bb_core::types::{
    DynamicTool, ExecutionOptions, PermissionEscalation, PermissionMode, ReasoningLevel,
    ServiceTier, SessionSpec, ToolCallResponse,
};
use indexmap::IndexMap;
use serde_json::{Value, json};

const INSTRUCTIONS: &str = "You are being recorded for a protocol test. Be brief.";

fn raw_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/raw")
}

fn base_options() -> ExecutionOptions {
    ExecutionOptions {
        model: "claude-haiku-4-5".into(),
        reasoning_level: ReasoningLevel::Low,
        service_tier: ServiceTier::Default,
        permission_mode: PermissionMode::AcceptEdits,
        permission_escalation: PermissionEscalation::Ask,
        provider_options: Default::default(),
    }
}

fn lookup() -> DynamicTool {
    serde_json::from_value(json!({
        "name": "lookup",
        "description": "Look up a value",
        "inputSchema": {"type": "object", "properties": {"key": {"type": "string"}}, "required": ["key"]},
    }))
    .unwrap()
}

fn spec(meta: &Value, tools: Vec<DynamicTool>, resume: bool) -> SessionSpec {
    let id = meta["providerThreadId"].as_str().map(str::to_owned);
    serde_json::from_value(json!({
        "threadId": meta["threadId"],
        "providerId": "claude-code",
        "cwd": meta["cwd"],
        "providerThreadId": if resume { id } else { None },
        "instructions": INSTRUCTIONS,
        "dynamicTools": tools,
        "env": {"BB_THREAD_ID": meta["threadId"]},
        "skillDirs": [],
    }))
    .unwrap()
}

/// Replays every raw scenario. Normalised: the per-run data dir (`--add-dir` and the sandbox
/// `allowWrite` root are taken from the recording and fed in as the host writable root), the
/// session id (taken from the recorded `--session-id=` / `--resume=`), and the initialize `request_id`.
#[test]
fn argv_env_and_initialize_match_recordings() {
    let mut scenarios = 0;
    for entry in std::fs::read_dir(raw_dir()).unwrap() {
        let dir = entry.unwrap().path();
        if !dir.join("argv.txt").exists() {
            continue;
        }
        scenarios += 1;
        let name = dir.file_name().unwrap().to_string_lossy().into_owned();
        let meta: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("meta.json")).unwrap()).unwrap();
        let argv = std::fs::read_to_string(dir.join("argv.txt")).unwrap();
        let recorded: Vec<&str> = argv.lines().collect();
        let add_dir = recorded.iter().position(|arg| *arg == "--add-dir").unwrap();
        let root = recorded[add_dir + 1].to_owned();
        let tools = if name == "dynamic-tool" { vec![lookup()] } else { vec![] };
        let spec = spec(&meta, tools, name == "resume");
        let settings = claude_settings(&base_options());
        let host = LaunchHost {
            process_env: IndexMap::from([("NODE_OPTIONS".into(), "--x".into())]),
            env: spec.env.clone(),
            writable_roots: vec![root],
        };
        let id = recorded
            .iter()
            .find_map(|arg| arg.strip_prefix("--session-id=").or(arg.strip_prefix("--resume=")))
            .unwrap();
        let session = SessionStart::for_spec(&spec, id);
        let launch = build_launch_with(&spec, &settings, &host, session, LaunchContext::default());
        assert_eq!(launch.args, recorded, "argv for {name}");
        assert_eq!(launch.cwd, meta["cwd"].as_str().unwrap());
        let env_txt = std::fs::read_to_string(dir.join("env.txt")).unwrap();
        for line in env_txt.lines() {
            let (key, value) = line.split_once('=').unwrap();
            assert_eq!(launch.env.get(key).map(String::as_str), Some(value), "{name} env {key}");
        }
        assert!(!launch.env.contains_key("NODE_OPTIONS"));
        let stdin = std::fs::read_to_string(dir.join("stdin.ndjson")).unwrap();
        let first: Value = serde_json::from_str(stdin.lines().next().unwrap()).unwrap();
        let mut expected = first["request"].clone();
        expected.as_object_mut().unwrap().remove("subtype");
        assert_eq!(serde_json::to_value(&launch.initialize).unwrap(), expected, "{name} init");
    }
    assert_eq!(scenarios, 8);
}

#[test]
fn settings_map_modes_flags_and_fixed() {
    let mut options = base_options();
    options.permission_mode = PermissionMode::Full;
    options.reasoning_level = ReasoningLevel::Ultracode;
    options.service_tier = ServiceTier::Fast;
    options.provider_options = serde_json::from_value(json!({
        "memoryEnabled": false, "workflowsDisabled": true, "subagentsDisabled": true,
        "disable1MContext": true, "chromeEnabled": true, "additionalWorkspaceWriteRoots": ["/x"],
    }))
    .unwrap();
    let settings = claude_settings(&options);
    assert_eq!(settings.base_mode, ClaudePermissionMode::BypassPermissions);
    assert!(!settings.subagents && !settings.workflows && settings.chrome);
    assert_eq!(settings.fixed(), json!(["bypassPermissions", true, true, ["/x"]]));
    assert_eq!(
        settings.flags.to_json(),
        json!({"autoMemoryEnabled": false, "enableWorkflows": false, "effortLevel": "xhigh",
               "ultracode": true, "fastMode": true})
    );
    options.provider_options = serde_json::from_value(json!({"chromeEnabled": "yes"})).unwrap();
    assert!(!claude_settings(&options).chrome);
    assert_eq!(sdk_effort(ReasoningLevel::None), "low");
    assert_eq!(sdk_effort(ReasoningLevel::Ultra), "max");
}

#[test]
fn bypass_launch_drops_sandbox_and_dirs_and_refuses_root() {
    let mut options = base_options();
    options.permission_mode = PermissionMode::Full;
    options.provider_options = serde_json::from_value(json!({"chromeEnabled": true})).unwrap();
    let settings = claude_settings(&options);
    let spec = spec(&json!({"threadId": "t", "cwd": "/w", "providerThreadId": "s"}), vec![], false);
    let host = LaunchHost { writable_roots: vec!["/r".into()], ..LaunchHost::default() };
    let context = LaunchContext { plugins: vec!["/p".into()], ..LaunchContext::default() };
    let launch = build_launch_with(&spec, &settings, &host, SessionStart::New("s".into()), context);
    let args = launch.args.join(" ");
    assert!(args.contains("--permission-mode bypassPermissions --allow-dangerously-skip-permissions --include-partial-messages --plugin-dir /p --session-id=s --replay-user-messages --chrome --settings"));
    assert!(!args.contains("--add-dir") && !args.contains("sandbox"));
    let root = LaunchContext { is_root: true, ..LaunchContext::default() };
    let launch = build_launch_with(&spec, &settings, &host, SessionStart::New("s".into()), root);
    assert_eq!(launch.permission_mode, ClaudePermissionMode::Default);
    assert!(!launch.args.join(" ").contains("dangerously"));
}

#[test]
fn resolves_explicit_and_path_executables() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let bin = temp.path().join("claude");
    std::fs::write(&bin, "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    let env = IndexMap::from([("PATH".to_owned(), format!("/nope:{}", temp.path().display()))]);
    let found = resolve_executable_with(None, &env).unwrap();
    assert_eq!(found.as_deref(), bin.to_str());
    assert_eq!(resolve_executable_with(None, &IndexMap::new()).unwrap(), None);
    let error = resolve_executable_with(Some(" /nope/claude "), &env).unwrap_err();
    assert_eq!(
        error.message,
        "BB_CLAUDE_CODE_EXECUTABLE must point to an executable Claude CLI path: /nope/claude"
    );
}

#[test]
fn materialises_skill_plugins() {
    let temp = tempfile::tempdir().unwrap();
    let skills = temp.path().join("skills-a").to_string_lossy().into_owned();
    std::fs::create_dir(&skills).unwrap();
    let root = temp.path().join("plugins");
    let dirs = vec![skills.clone(), skills.clone(), "/b".to_owned()];
    let plugins = skill_plugins_in(&root, &dirs);
    assert_eq!(plugins.len(), 2);
    let manifest =
        std::fs::read_to_string(Path::new(&plugins[0]).join(".claude-plugin/plugin.json"));
    let manifest: Value = serde_json::from_str(&manifest.unwrap()).unwrap();
    assert_eq!(manifest["name"], "bb-global-skills");
    let second = std::fs::read_to_string(Path::new(&plugins[1]).join(".claude-plugin/plugin.json"));
    assert!(second.unwrap().contains("\"name\": \"bb-global-skills-"));
    assert_eq!(
        std::fs::read_link(Path::new(&plugins[0]).join("skills")).unwrap(),
        Path::new(&skills)
    );
}

#[tokio::test]
async fn tool_server_maps_results() {
    let caller: ToolCaller = Arc::new(|tool, input, id| {
        Box::pin(async move {
            assert_eq!((tool.as_str(), id.as_deref()), ("lookup", Some("toolu_1")));
            if input["fail"] == true {
                return Err(bb_core::RunnerError::new(
                    bb_core::RunnerErrorCode::MissingExecutable,
                    "boom",
                ));
            }
            Ok(ToolCallResponse { content_items: vec![], success: true })
        })
    });
    let server = bb_tool_server(&[lookup()], caller);
    assert_eq!(server.tools()[0].input_schema["required"], json!(["key"]));
    let call = |args: Value| {
        json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
               "params": {"name": "lookup", "arguments": args, "_meta": {"claudecode/toolUseId": "toolu_1"}}})
    };
    let ok = server.handle(call(json!({}))).await;
    assert_eq!(ok["result"], json!({"content": [{"type": "text", "text": "OK"}]}));
    let failed = server.handle(call(json!({"fail": true}))).await;
    assert_eq!(
        failed["result"],
        json!({"content": [{"type": "text", "text": "boom"}], "isError": true})
    );
    let bad = ToolCallResponse { content_items: vec![], success: false };
    assert_eq!(tool_content(&bad), vec![json!({"type": "text", "text": "Tool call failed"})]);
}

#[test]
fn builds_models_with_names_aliases_and_default() {
    let discovered = parse_models(&json!([
        {"value": "default", "displayName": "Default", "description": "d", "resolvedModel": "claude-sonnet-4-6"},
        {"value": "haiku", "displayName": "Haiku", "description": "h", "resolvedModel": "claude-haiku-4-5-20251001", "supportedEffortLevels": ["low", "medium"]},
        {"value": "claude-sonnet-4-6", "displayName": "Sonnet", "description": "s", "supportedEffortLevels": ["low", "high", "xhigh"]},
        {"value": "opus[1m]", "displayName": "Opus 1M", "description": "o", "resolvedModel": "claude-opus-4[1m]"},
    ]));
    let built = build_models(&discovered);
    let names: Vec<_> = built
        .models
        .iter()
        .map(|m| (m.model.as_str(), m.display_name.as_str(), m.is_default))
        .collect();
    assert_eq!(
        names,
        vec![
            ("claude-haiku-4-5-20251001", "Haiku 4.5", false),
            ("claude-sonnet-4-6", "Sonnet 4.6", true),
            ("claude-opus-4[1m]", "Opus 4 (1M)", false),
        ]
    );
    let sonnet = &built.models[1];
    assert_eq!(sonnet.default_reasoning_effort, ReasoningLevel::High);
    let efforts: Vec<_> =
        sonnet.supported_reasoning_efforts.iter().map(|e| e.reasoning_effort).collect();
    assert_eq!(
        efforts,
        vec![
            ReasoningLevel::Low,
            ReasoningLevel::High,
            ReasoningLevel::Xhigh,
            ReasoningLevel::Ultracode
        ]
    );
    assert_eq!(built.models[0].default_reasoning_effort, ReasoningLevel::Medium);
    assert_eq!(built.models[2].default_reasoning_effort, ReasoningLevel::Low);
    let aliases: Vec<_> =
        built.selected_only_models.iter().map(|m| m.display_name.as_str()).collect();
    assert_eq!(aliases, vec!["Haiku alias", "Opus 1M alias"]);
}

#[test]
fn prompt_text_formats_attachments_and_skills() {
    let input = vec![
        json!({"type": "text", "text": "use $deploy now", "mentions": [
            {"start": 4, "end": 11, "resource": {"kind": "command", "source": "skill", "trigger": "$", "name": "deploy"}}]}),
        json!({"type": "image", "url": "https://x/y.png"}),
        json!({"type": "localImage", "path": "/i.png"}),
        json!({"type": "localFile", "path": "/f.txt", "name": "f.txt", "mimeType": "text/plain", "sizeBytes": 12}),
        json!({"type": "text", "text": "", "mentions": []}),
    ];
    assert_eq!(
        prompt_text(&input).unwrap(),
        "use /deploy now\n[Attached image: https://x/y.png]\n[Attached image. It is on disk at /i.png — use the Read tool to view it.]\n[Attached file \"f.txt\" (text/plain, 12 bytes). It is on disk at /f.txt — use the Read tool to view it.]"
    );
    assert_eq!(prompt_text(&[]), None);
}

#[test]
fn a_custom_model_changes_the_environment_and_needs_a_new_process() {
    let meta = json!({"threadId": "t", "cwd": "/w", "providerThreadId": "s"});
    let mut spec = spec(&meta, vec![], false);
    spec.custom_models = serde_json::from_value(json!([{
        "model": "claude-preview-9",
        "env": {"PREVIEW_CONFIG_URL": "https://example.test/config.json", "KEPT": "new"},
        "unsetEnv": ["DROPPED"],
    }]))
    .unwrap();
    let mut options = base_options();
    let plain = session_settings(&spec, &options);
    assert_eq!(plain, claude_settings(&options));
    options.model = "claude-preview-9".into();
    let custom = session_settings(&spec, &options);
    assert_eq!(custom.custom.as_ref(), spec.custom_models.first());
    let (plain_fixed, custom_fixed) = (plain.fixed(), custom.fixed());
    assert_eq!(custom_fixed.as_array().unwrap()[..4], plain_fixed.as_array().unwrap()[..]);
    assert_eq!(custom_fixed[4]["model"], "claude-preview-9");

    let inherited = [("DROPPED", "1"), ("KEPT", "old"), ("OTHER", "x")];
    let process_env = inherited.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    let host = LaunchHost { process_env, ..LaunchHost::default() };
    let env = child_env(&host, &custom);
    let value = |env: &IndexMap<String, String>, name: &str| env.get(name).cloned();
    assert_eq!(
        value(&env, "PREVIEW_CONFIG_URL").as_deref(),
        Some("https://example.test/config.json")
    );
    assert_eq!(value(&env, "KEPT").as_deref(), Some("new"));
    assert_eq!((value(&env, "DROPPED"), value(&env, "OTHER").as_deref()), (None, Some("x")));
    let env = child_env(&host, &plain);
    assert_eq!(value(&env, "PREVIEW_CONFIG_URL"), None);
    assert_eq!(value(&env, "DROPPED").as_deref(), Some("1"));
}
