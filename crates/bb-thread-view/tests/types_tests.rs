use bb_thread_view::event::{self, EventScope};
use bb_thread_view::rows::*;
use bb_thread_view::types::*;
use serde_json::{Value, json};

fn base(id: &str, turn_id: Option<&str>) -> RowBase {
    RowBase {
        id: id.into(),
        thread_id: "thr".into(),
        turn_id: turn_id.map(Into::into),
        source_seq_start: 1,
        source_seq_end: 2,
        started_at: 100,
        created_at: 200,
    }
}

fn assert_json(row: &TimelineRow, expected: &str) {
    assert_eq!(serde_json::to_string(row).unwrap(), expected);
    let back: TimelineRow = serde_json::from_str(expected).unwrap();
    assert_eq!(&back, row);
}

const BASE: &str = r#""id":"r1","threadId":"thr","turnId":"t1","sourceSeqStart":1,"sourceSeqEnd":2,"startedAt":100,"createdAt":200"#;

#[test]
fn command_work_row_serializes_in_contract_order() {
    let row: TimelineRow = WorkRow {
        base: base("r1", Some("t1")),
        kind: WorkTag,
        status: RowStatus::Completed,
        work: WorkDetail::Command(CommandWork {
            work_kind: CommandTag,
            call_id: "c1".into(),
            command: "ls".into(),
            cwd: None,
            source: None,
            output: "a".into(),
            output_preview: Some(OutputPreview {
                full_output_availability: FullOutputAvailability::DetailLimit,
                total_chars: 9,
            }),
            exit_code: Some(0),
            completed_at: Some(300),
            approval_status: None,
            activity_intents: vec![ActivityIntent::ListFiles { command: "ls".into(), path: None }],
            presentation: None,
        }),
    }
    .into();
    assert_json(
        &row,
        &format!(
            r#"{{{BASE},"kind":"work","status":"completed","workKind":"command","callId":"c1","command":"ls","cwd":null,"source":null,"output":"a","outputPreview":{{"experimental_fullOutputAvailability":"detail-limit","totalChars":9}},"exitCode":0,"completedAt":300,"approvalStatus":null,"activityIntents":[{{"type":"list_files","command":"ls","path":null}}]}}"#
        ),
    );
}

#[test]
fn approval_and_system_rows() {
    let approval: TimelineRow = WorkRow {
        base: base("r1", Some("t1")),
        kind: WorkTag,
        status: RowStatus::Pending,
        work: WorkDetail::Approval(ApprovalWork {
            work_kind: ApprovalTag,
            interaction_id: "i1".into(),
            target: ApprovalTarget { item_id: "it".into(), tool_name: Some("Bash".into()) },
            approval: ApprovalDetail::PermissionGrant(PermissionGrantApprovalFields {
                approval_kind: PermissionGrantApprovalTag,
                lifecycle: PermissionGrantLifecycle::Granted,
                grant_scope: Some(PermissionGrantScope::Session),
                status_reason: None,
            }),
        }),
    }
    .into();
    assert_json(
        &approval,
        &format!(
            r#"{{{BASE},"kind":"work","status":"pending","workKind":"approval","interactionId":"i1","target":{{"itemId":"it","toolName":"Bash"}},"approvalKind":"permission-grant","lifecycle":"granted","grantScope":"session","statusReason":null}}"#
        ),
    );

    let reasoning: TimelineRow = SystemRow {
        base: base("r1", Some("t1")),
        kind: SystemTag,
        title: "Thinking".into(),
        detail: None,
        status: Some(RowStatus::Pending),
        system: SystemDetail::Operation(GenericOperationFields {
            system_kind: OperationSystemKindTag,
            operation_kind: SystemOperationKind::ContextClear,
            reasoning_id: Some("rs".into()),
            completed_at: None,
        }),
    }
    .into();
    assert_json(
        &reasoning,
        &format!(
            r#"{{{BASE},"kind":"system","title":"Thinking","detail":null,"status":"pending","systemKind":"operation","operationKind":"context-clear","reasoningId":"rs","completedAt":null}}"#
        ),
    );

    let error: TimelineRow = SystemRow {
        base: base("r1", Some("t1")),
        kind: SystemTag,
        title: "Oops".into(),
        detail: Some("d".into()),
        status: None,
        system: SystemDetail::NonOperation(NonOperationSystemFields {
            system_kind: NonOperationSystemKind::Error,
        }),
    }
    .into();
    assert_json(
        &error,
        &format!(
            r#"{{{BASE},"kind":"system","title":"Oops","detail":"d","status":null,"systemKind":"error"}}"#
        ),
    );
}

#[test]
fn conversation_and_turn_rows() {
    let assistant: TimelineRow = ConversationRow {
        base: base("r1", Some("t1")),
        kind: ConversationTag,
        text: "hi".into(),
        attachments: None,
        role: ConversationRole::Assistant(AssistantConversationFields::default()),
    }
    .into();
    let assistant_json = format!(
        r#"{{{BASE},"kind":"conversation","text":"hi","attachments":null,"role":"assistant","turnRequest":null}}"#
    );
    assert_json(&assistant, &assistant_json);

    let user: TimelineRow = ConversationRow {
        base: base("r2", None),
        kind: ConversationTag,
        text: "go".into(),
        attachments: Some(ConversationAttachments::default()),
        role: ConversationRole::User(UserConversationFields {
            role: UserRoleTag,
            initiator: "user".into(),
            sender_thread_id: None,
            system_message_kind: "none".into(),
            system_message_subject: None,
            turn_request: ConversationTurnRequest {
                is_grouped: false,
                kind: TurnRequestKind::Steer,
                status: TurnRequestStatus::Accepted,
            },
            mentions: vec![],
        }),
    }
    .into();
    assert!(serde_json::to_string(&user).unwrap().ends_with(
        r#""kind":"conversation","text":"go","attachments":{"webImages":0,"localImages":0,"localFiles":0,"imageUrls":[],"localImagePaths":[],"localFilePaths":[]},"role":"user","initiator":"user","senderThreadId":null,"systemMessageKind":"none","systemMessageSubject":null,"turnRequest":{"isGrouped":false,"kind":"steer","status":"accepted"},"mentions":[]}"#
    ));

    let turn: TimelineRow = TurnRow {
        base: base("r1", Some("t1")),
        kind: TurnTag,
        status: RowStatus::Interrupted,
        summary_count: 1,
        completed_at: None,
        children: Some(vec![assistant.clone()]),
    }
    .into();
    assert_json(
        &turn,
        &format!(
            r#"{{{BASE},"kind":"turn","status":"interrupted","summaryCount":1,"completedAt":null,"children":[{assistant_json}]}}"#
        ),
    );
    assert_eq!(turn.kind(), "turn");

    let delta = compute_timeline_row_delta(
        std::slice::from_ref(&assistant),
        &[user.clone(), assistant.clone()],
    );
    assert_eq!(delta.upsert_rows, vec![user.clone()]);
    assert_eq!(delta.row_order, Some(vec!["r2".to_string(), "r1".to_string()]));
    assert_eq!(
        apply_timeline_delta(std::slice::from_ref(&assistant), &delta),
        Some(vec![user, assistant])
    );
}

fn fixture() -> Vec<Value> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/runner/test/fixtures/claude/turn-tools.events.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn accessors_on_recorded_claude_events() {
    let events = fixture();
    let identity = &events[0];
    assert_eq!(event::event_type(identity), "thread/identity");
    assert_eq!(event::scope(identity), Some(EventScope::Thread));
    assert_eq!(event::turn_id(identity), None);
    assert_eq!(event::provider_thread_id(identity), Some("915e478a-895c-4f18-b606-3fda63bf2649"));

    let accepted = &events[3];
    assert_eq!(event::turn_id(accepted), Some("da00000000-t1"));
    assert_eq!(event::client_request_id(accepted), Some("creq_heqd62cpd8"));
    assert_eq!(event::item(accepted), None);

    let started = &events[6];
    assert!(event::is_type(started, "item/started"));
    let item = event::item(started).unwrap();
    assert_eq!(event::item_type(item), Some("commandExecution"));
    assert_eq!(event::event_item_id(started), Some("da00000000-i1"));
    assert_eq!(event::item_status(item), Some("pending"));
    assert_eq!(event::item_approval_status(item), None);
    assert_eq!(event::str_field(item, "command"), Some("cat /tmp/bb-recording-ws/math.js"));
    assert!(event::item_presentation(item).is_some());
    assert_eq!(event::parent_tool_call_id(started), None);

    let usage = &events[5];
    let window = event::field(usage, "contextWindowUsage").unwrap();
    assert_eq!(event::i64_field(window, "usedTokens"), Some(28777));
    assert_eq!(event::bool_field(window, "estimated"), Some(true));
}

#[test]
fn accessors_tolerate_odd_shapes() {
    for odd in [json!(null), json!(3), json!({"type": 7, "scope": "turn", "item": []})] {
        assert_eq!(event::event_type(&odd), "");
        assert_eq!(event::scope(&odd), None);
        assert_eq!(event::scope_or_thread(&odd), EventScope::Thread);
        assert_eq!(event::item(&odd), None);
        assert_eq!(event::parent_tool_call_id(&odd), None);
    }
    let watchdog = json!({"type": "system/provider-turn-watchdog", "providerThreadId": "p"});
    assert_eq!(event::provider_thread_id(&watchdog), None);
    let nested = json!({"item": {"parentToolCallId": "tc"}, "parentToolCallId": "outer"});
    assert_eq!(get_event_parent_tool_call_id(&nested), Some("tc"));
    assert_eq!(event::i64_field(&json!({"n": 4.0}), "n"), Some(4));
    assert_eq!(
        serde_json::to_value(scope_for_turn(Some("t"))).unwrap(),
        json!({"kind": "turn", "turnId": "t"})
    );
    assert_eq!(scope_for_turn(Some("")), EventScope::Thread);
}

#[test]
fn visible_text_buffer() {
    let mut buffer = VisibleTextBuffer::new();
    buffer.append("hel");
    buffer.append("lo\nwor");
    assert_eq!((buffer.visible.as_str(), buffer.pending.as_str()), ("hello\n", "wor"));
    assert!(buffer.flush());
    assert!(!buffer.flush());
    buffer.set("a\nb", false);
    assert_eq!((buffer.visible.as_str(), buffer.pending.as_str()), ("a\n", "b"));
    buffer.set("a\nb", true);
    assert_eq!((buffer.visible.as_str(), buffer.pending.as_str()), ("a\nb", ""));
}
