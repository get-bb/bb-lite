mod replay;

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bb_claude::session::{ClaudeAdapterOptions, SpawnClaude, create_claude_adapter};
use bb_core::env::EnvMap;
use bb_core::{ExecutionOptions, RunnerResult, SessionSpec, ToolCallResponse};
use bb_provider::{
    EventBuilder, EventBuilderOptions, ExitInfo, Interaction, ProviderSession, SessionHost,
    SessionHostCallbacks, ToolCall, TurnInput,
};
use parking_lot::Mutex;
use replay::{Scripted, scripted_child};
use serde_json::{Value, json};
use tokio::sync::mpsc;

const SESSION: &str = "sess-1";

#[derive(Default)]
struct Host {
    tool_calls: Mutex<Vec<ToolCall>>,
}

#[async_trait]
impl SessionHostCallbacks for Host {
    async fn call_tool(&self, call: ToolCall) -> RunnerResult<ToolCallResponse> {
        self.tool_calls.lock().push(call);
        Ok(serde_json::from_value(json!({
            "contentItems": [{"type": "inputText", "text": "moved"}], "success": true
        }))
        .expect("response"))
    }

    async fn request_interaction(&self, _interaction: Interaction) -> RunnerResult<Value> {
        Ok(json!({"decision": "deny"}))
    }

    fn on_exit(&self, _info: ExitInfo) {}
}

struct Launched {
    args: Vec<String>,
    env: EnvMap,
}

struct Live {
    session: Arc<dyn ProviderSession>,
    child: Scripted,
    host: Arc<Host>,
    events: Arc<Mutex<Vec<Value>>>,
    builder: Arc<EventBuilder>,
    launched: Launched,
    initialize: Value,
}

fn base_spec() -> Value {
    json!({
        "threadId": "thr_1", "providerId": "claude-code", "cwd": "/tmp", "providerThreadId": null,
        "instructions": "", "dynamicTools": [], "env": {}, "skillDirs": []
    })
}

fn base_options() -> Value {
    json!({
        "model": "claude-opus-5[1m]", "reasoningLevel": "medium", "serviceTier": "default",
        "permissionMode": "accept-edits", "permissionEscalation": "ask", "planMode": false,
        "providerOptions": {"memoryEnabled": true, "subagentsDisabled": false,
            "workflowsDisabled": false}
    })
}

fn merged(mut base: Value, changes: &Value) -> Value {
    if let (Some(base), Some(changes)) = (base.as_object_mut(), changes.as_object()) {
        base.extend(changes.clone());
    }
    base
}

fn spec_of(changes: &Value) -> SessionSpec {
    serde_json::from_value(merged(base_spec(), changes)).expect("spec")
}

fn options_of(changes: &Value) -> ExecutionOptions {
    serde_json::from_value(merged(base_options(), changes)).expect("options")
}

fn env_map(value: Value) -> EnvMap {
    serde_json::from_value(value).expect("env")
}

async fn open(spec: Value, options: Value, env: Value, process_env: Value) -> Live {
    let (sender, mut children) = mpsc::unbounded_channel::<(Scripted, Launched)>();
    let spawn: SpawnClaude = Arc::new(move |_: &str, args: &[String], _: &str, env: &EnvMap| {
        let (child, scripted) = scripted_child();
        let launched = Launched { args: args.to_vec(), env: env.clone() };
        let _ = sender.send((scripted, launched));
        child
    });
    let adapter = create_claude_adapter(ClaudeAdapterOptions {
        spawn: Some(spawn),
        executable: Some("/bin/claude-scripted".to_owned()),
        session_id: Some(Arc::new(|| SESSION.to_owned())),
    });
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let builder = Arc::new(EventBuilder::with_options(EventBuilderOptions {
        text_flush_ms: 0,
        ..EventBuilderOptions::new(Arc::new(move |event| sink.lock().push(event)))
    }));
    let host = Arc::new(Host::default());
    let session_host = SessionHost {
        events: builder.clone(),
        env: env_map(env),
        process_env: env_map(process_env),
        thread_storage_dir: String::new(),
        writable_roots: vec![],
        callbacks: host.clone(),
    };
    let session =
        adapter.open(spec_of(&spec), options_of(&options), session_host).await.expect("open");
    let (mut child, launched) = children.recv().await.expect("child");
    let initialize = child.next_written().await.expect("initialize");
    assert_eq!(initialize["request"]["subtype"], "initialize");
    reply(&mut child, &initialize).await;
    Live { session, child, host, events, builder, launched, initialize }
}

async fn reply(child: &mut Scripted, request: &Value) {
    let response = json!({"type": "control_response", "response": {"subtype": "success",
        "request_id": request["request_id"], "response": {}}});
    child.write_line(&response.to_string()).await;
}

impl Live {
    async fn turn(&mut self, text: &str, changes: Value) -> Vec<Value> {
        let session = self.session.clone();
        let input = TurnInput {
            client_request_id: "req-1".into(),
            input: vec![json!({"type": "text", "text": text})],
            options: options_of(&changes),
        };
        let started = tokio::spawn(async move { session.start_turn(input).await });
        let mut controls = Vec::new();
        loop {
            let frame = self.child.next_written().await.expect("frame");
            if frame["type"] == "control_request" {
                controls.push(frame["request"].clone());
                reply(&mut self.child, &frame).await;
                continue;
            }
            assert_eq!(frame["type"], "user");
            assert_eq!(frame["message"]["content"], text);
            break;
        }
        started.await.expect("join").expect("turn");
        controls
    }

    async fn emit(&mut self, messages: &[Value]) {
        for message in messages {
            self.child.write_line(&message.to_string()).await;
        }
        settle().await;
    }

    fn items(&self, kind: &str) -> Vec<Value> {
        let events = self.events.lock();
        events
            .iter()
            .filter(|event| event["type"] == kind)
            .filter_map(|event| event.get("item").cloned())
            .collect()
    }

    async fn control(&mut self, request: Value) -> Value {
        let frame = json!({"type": "control_request", "request_id": "mcp-1", "request": request});
        self.child.write_line(&frame.to_string()).await;
        let written = self.child.next_written().await.expect("control response");
        assert_eq!(written["response"]["subtype"], "success", "{written}");
        written["response"]["response"].clone()
    }
}

async fn settle() {
    tokio::time::sleep(Duration::from_millis(60)).await;
}

fn brief(item: &Value) -> String {
    let shown = &item["presentation"];
    let suppress = shown["suppress"].as_bool() == Some(true);
    let parts = [
        item["type"].as_str(),
        shown["label"]["pending"].as_str(),
        shown["icon"]["glyph"].as_str(),
        shown["title"].as_str(),
        shown["detail"].as_str(),
        suppress.then_some("hidden"),
        shown["badge"]["label"].as_str(),
    ];
    let parts: Vec<&str> = parts.into_iter().flatten().filter(|part| !part.is_empty()).collect();
    parts.join(" | ")
}

fn assistant(content: Vec<Value>) -> Value {
    let message = json!({"role": "assistant", "content": content, "usage": {"input_tokens": 5}});
    json!({"type": "assistant", "message": message, "parent_tool_use_id": null,
        "session_id": SESSION})
}

fn tool_use(id: &str, name: &str, input: Value) -> Value {
    json!({"type": "tool_use", "id": id, "name": name, "input": input})
}

fn tool_result(id: &str, content: Value, extra: Value) -> Value {
    let block = json!({"type": "tool_result", "tool_use_id": id, "content": content,
        "is_error": false});
    let message = json!({"role": "user", "content": [block]});
    merged(json!({"type": "user", "message": message, "session_id": SESSION}), &extra)
}

fn arg_after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    let index = args.iter().position(|arg| arg == flag)?;
    args.get(index + 1).map(String::as_str)
}

#[tokio::test]
async fn labels_escaped_commands_and_bb_tools_and_serves_bb_tools() {
    let input_schema = json!({"type": "object", "properties": {}});
    let presentation = json!({"label": {"pending": "Nooping", "completed": "Nooped"},
        "icon": {"glyph": "Zap"}});
    let noop = json!({"name": "noop", "description": "Nothing", "inputSchema": input_schema,
        "presentation": presentation});
    let spec = json!({"dynamicTools": [noop]});
    let mut live = open(spec, json!({}), json!({}), json!({})).await;
    live.turn("go", json!({})).await;
    let report = "agentId: 7\nFound it\n<usage>1</usage>";
    live.emit(&[
        assistant(vec![
            tool_use(
                "t1",
                "Bash",
                json!({"command": "ls\npwd", "run_in_background": true,
                    "dangerouslyDisableSandbox": true}),
            ),
            tool_use("t2", "Task", json!({"description": "Dig", "subagent_type": "Explore"})),
            tool_use("t3", "mcp__github__create_issue", json!({"title": "x"})),
            tool_use("t4", "mcp__bb-bridge__noop", json!({})),
        ]),
        tool_result("t2", json!([{"type": "text", "text": report}]), json!({})),
    ])
    .await;
    let started = live.items("item/started");
    let briefs: Vec<String> = started.iter().map(brief).collect();
    assert_eq!(
        briefs,
        [
            "commandExecution | Starting background command | Terminal | ls | Outside of sandbox",
            "delegation | Running subagent | UserRound | Dig | Explore agent",
            "toolCall | Running create_issue | Toolbox | github",
            "toolCall | Nooping | Zap",
        ]
    );
    assert_eq!(started[2]["server"], "github");
    assert_eq!(started[2]["arguments"], json!({"title": "x"}));
    let completed = live.items("item/completed");
    assert_eq!(completed[0]["type"], "delegation");
    assert_eq!(completed[0]["summary"], "Found it");
    let args = &live.launched.args;
    assert_eq!(arg_after(args, "--allowedTools"), Some("mcp__bb-bridge__noop"));
    assert_eq!(live.initialize["request"]["sdkMcpServers"], json!(["bb-bridge"]));
    let message = |id: i64, method: &str, params: Value| {
        json!({"subtype": "mcp_message", "server_name": "bb-bridge",
            "message": {"jsonrpc": "2.0", "id": id, "method": method, "params": params}})
    };
    let listed = live.control(message(1, "tools/list", json!({}))).await;
    let tools = &listed["mcp_response"]["result"]["tools"];
    assert_eq!(tools[0]["name"], "noop");
    assert_eq!(tools[0]["inputSchema"], input_schema);
    let meta = json!({"claudecode/toolUseId": "t4"});
    let call = message(2, "tools/call", json!({"name": "noop", "_meta": meta}));
    let result = live.control(call).await;
    let content = &result["mcp_response"]["result"]["content"];
    assert_eq!(content, &json!([{"type": "text", "text": "moved"}]));
    let forwarded = live.host.tool_calls.lock().clone();
    assert_eq!(forwarded.len(), 1);
    assert_eq!(forwarded[0].tool, "noop");
    assert_eq!(forwarded[0].arguments, json!({}));
    assert_eq!(forwarded[0].turn_id, live.builder.active_turn_id());
    assert_eq!(Some(forwarded[0].call_id.clone()), live.builder.bb_item_id("t4"));
}

#[tokio::test]
async fn folds_task_tools_into_plan_steps_and_tracks_background_tasks() {
    let mut live = open(json!({}), json!({}), json!({}), json!({})).await;
    live.turn("go", json!({})).await;
    let task = json!({"type": "system", "task_id": "b1", "session_id": SESSION});
    let started = json!({"subtype": "task_started", "tool_use_id": "t3",
        "task_type": "local_bash", "description": "Watch"});
    live.emit(&[
        assistant(vec![tool_use(
            "t1",
            "TaskCreate",
            json!({"subject": "Write tests", "activeForm": "Writing tests"}),
        )]),
        tool_result(
            "t1",
            json!("ok"),
            json!({"tool_use_result": {"task": {"id": "1", "subject": "Write tests"}}}),
        ),
        assistant(vec![tool_use(
            "t2",
            "TaskUpdate",
            json!({"taskId": "1", "status": "in_progress"}),
        )]),
        tool_result(
            "t2",
            json!("ok"),
            json!({"tool_use_result": {"success": true, "taskId": "1"}}),
        ),
        assistant(vec![tool_use(
            "t3",
            "Bash",
            json!({"command": "sleep 9", "run_in_background": true}),
        )]),
        merged(task.clone(), &started),
        json!({"type": "result", "subtype": "success", "is_error": false, "session_id": SESSION}),
    ])
    .await;
    assert!(live.builder.has_open_background_work());
    let outcome = json!({"status": "completed", "summary": "exit 0"});
    let notified = json!({"subtype": "task_notification", "output_file": "/o"});
    live.emit(&[merged(merged(task, &notified), &outcome)]).await;
    assert!(!live.builder.has_open_background_work());
    let completed = live.items("item/completed");
    let plans: Vec<&Value> = completed.iter().filter(|item| item["type"] == "planSteps").collect();
    let steps: Vec<Value> = plans.iter().map(|plan| plan["steps"].clone()).collect();
    assert_eq!(
        steps,
        [
            json!([{"step": "Write tests", "status": "pending"}]),
            json!([{"step": "Writing tests", "status": "active"}]),
        ]
    );
    assert_eq!(brief(plans[1]), "planSteps | Updating plan | ListTodo | Writing tests | hidden");
    let events = live.events.lock().clone();
    let [closed, late] = &events[events.len() - 2..] else { panic!("too few events") };
    assert_eq!(closed["type"], "turn/completed");
    assert_eq!(late["scope"]["kind"], "thread", "{late}");
    let finished = live.items("item/backgroundTask/completed");
    let finished = finished.first().expect("background task completed");
    assert_eq!(finished["familyId"], "b1");
    assert_eq!(finished["status"], "completed");
    assert_eq!(finished["summary"], "exit 0");
    assert_eq!(finished["taskStatus"], "completed");
    assert_eq!(finished["outputFile"], "/o");
    assert_eq!(brief(finished), "backgroundTask | Running background command | Terminal | Watch");
}

#[tokio::test]
async fn builds_the_launch_from_the_spec_and_applies_later_changes_live() {
    let skills = tempfile::tempdir().expect("skills");
    let skill_dir = skills.path().to_string_lossy().into_owned();
    let env = json!({"BB_THREAD_ID": "thr_1", "ANTHROPIC_BASE_URL": "http://pool"});
    let process_env = json!({"HOME": "/home/u", "CLAUDE_AGENT_SDK_CLIENT_APP": "x"});
    let spec = json!({"providerThreadId": "sess-0", "instructions": "Be brief.",
        "skillDirs": [skill_dir]});
    let start = json!({"model": "opus[1m]", "reasoningLevel": "ultracode"});
    let mut live = open(spec.clone(), start.clone(), env, process_env).await;
    let args = live.launched.args.clone();
    assert!(args.contains(&"--resume=sess-0".to_owned()), "{args:?}");
    assert_eq!(arg_after(&args, "--model"), Some("opus[1m]"));
    assert_eq!(arg_after(&args, "--permission-mode"), Some("acceptEdits"));
    assert_eq!(arg_after(&args, "--disallowedTools"), Some("EnterPlanMode,ExitPlanMode"));
    assert_eq!(arg_after(&args, "--effort"), Some("xhigh"));
    assert_eq!(live.initialize["request"]["appendSystemPrompt"], "Be brief.");
    let settings: Value =
        serde_json::from_str(arg_after(&args, "--settings").expect("settings")).expect("json");
    assert_eq!(settings["autoMemoryEnabled"], true);
    assert_eq!(settings["enableWorkflows"], true);
    assert_eq!(settings["ultracode"], true);
    assert_eq!(settings["fastMode"], false);
    assert_eq!(settings["sandbox"]["enabled"], true);
    let child_env = &live.launched.env;
    assert_eq!(child_env.get("BB_THREAD_ID").map(String::as_str), Some("thr_1"));
    assert_eq!(child_env.get("ANTHROPIC_BASE_URL").map(String::as_str), Some("http://pool"));
    assert_eq!(child_env.get("HOME").map(String::as_str), Some("/home/u"));
    assert_eq!(child_env.get("CLAUDE_CODE_ENTRYPOINT").map(String::as_str), Some("cli"));
    assert!(!child_env.contains_key("CLAUDE_AGENT_SDK_CLIENT_APP"));
    let plugin = std::path::Path::new(arg_after(&args, "--plugin-dir").expect("plugin dir"));
    let manifest = std::fs::read_to_string(plugin.join(".claude-plugin/plugin.json"))
        .expect("plugin manifest");
    let manifest: Value = serde_json::from_str(&manifest).expect("manifest json");
    assert_eq!(manifest["name"], "bb-global-skills");
    let changes = json!({"model": "sonnet", "serviceTier": "fast"});
    let next = merged(start, &changes);
    let controls = live.turn("think", next.clone()).await;
    let flags = json!({"autoMemoryEnabled": true, "enableWorkflows": true,
        "effortLevel": "xhigh", "ultracode": true, "fastMode": true});
    assert_eq!(
        controls,
        [
            json!({"subtype": "set_model", "model": "sonnet"}),
            json!({"subtype": "apply_flag_settings", "settings": flags}),
        ]
    );
    let effort = merged(next.clone(), &json!({"reasoningLevel": "high"}));
    let controls = live.turn("again", effort).await;
    let flags = json!({"autoMemoryEnabled": true, "enableWorkflows": true,
        "effortLevel": "high", "ultracode": false, "fastMode": true});
    assert_eq!(controls, [json!({"subtype": "apply_flag_settings", "settings": flags})]);
    assert!(
        live.turn(
            "same",
            json!({"model": "sonnet", "reasoningLevel": "high",
        "serviceTier": "fast"})
        )
        .await
        .is_empty()
    );
    let next = options_of(&next);
    assert!(live.session.can_apply(&spec_of(&spec), &next));
    let full = options_of(&json!({"permissionMode": "full"}));
    assert!(!live.session.can_apply(&spec_of(&spec), &full));
    let moved = merged(spec, &json!({"cwd": "/b"}));
    assert!(!live.session.can_apply(&spec_of(&moved), &next));
}
