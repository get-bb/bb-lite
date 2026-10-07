use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use bb_server::db::pending_interactions::*;
use bb_server::db::queued_messages::*;
use bb_server::db::thread_read::*;
use bb_server::db::thread_search::*;
use bb_server::db::{Db, OnConflict, RowValues, insert_row};
use bb_server::domain::pending_interaction::*;
use bb_server::domain::queued_message::*;
use bb_server::domain::thread::ThreadOriginKind;
use bb_server::row;
use serde_json::json;

fn open() -> Db {
    let clock = Arc::new(AtomicI64::new(1_000));
    Db::open_in_memory(Some(Arc::new(move || clock.fetch_add(1, Ordering::SeqCst)))).unwrap()
}

fn insert(db: &Db, table: &str, values: RowValues) {
    insert_row(db, table, &values, OnConflict::Fail).unwrap();
}

fn project(db: &Db, id: &str) {
    insert(db, "projects", row! { "id" => id, "name" => id, "createdAt" => 1, "updatedAt" => 1 });
}

fn thread(db: &Db, id: &str, project_id: &str, created_at: i64, extra: RowValues) {
    let mut values = row! {
        "id" => id, "projectId" => project_id, "providerId" => "codex",
        "status" => "idle", "latestAttentionAt" => created_at,
        "createdAt" => created_at, "updatedAt" => created_at,
    };
    for key in extra.keys().map(str::to_owned).collect::<Vec<_>>() {
        values.put(&key, extra.get(&key).unwrap().clone());
    }
    insert(db, "threads", values);
}

fn seeded() -> Db {
    let db = open();
    project(&db, "prj_a");
    project(&db, "prj_b");
    thread(&db, "thr_a", "prj_a", 10, RowValues::new());
    db
}

fn new_message(
    thread_id: &str,
    text: &str,
    waiting_on: Option<QueuedMessageWaitingOn>,
) -> NewQueuedMessage {
    NewQueuedMessage {
        thread_id: thread_id.into(),
        sender_thread_id: None,
        send_at: None,
        content: vec![json!({ "type": "text", "text": text })],
        model: "gpt-5".into(),
        reasoning_level: "medium".into(),
        permission_mode: "full".into(),
        service_tier: "default".into(),
        waiting_on,
        system_notice: None,
    }
}

fn ids(rows: &[ThreadListRow]) -> Vec<&str> {
    rows.iter().map(|row| row.id.as_str()).collect()
}

#[test]
fn queue_keeps_insertion_order_and_parses_waits() {
    let db = seeded();
    let host = QueuedMessageWaitingOn::HostOffline { host_name: "Laptop".into() };
    let first = insert_queued_message(&db, new_message("thr_a", "one", None)).unwrap();
    let second =
        insert_queued_message(&db, new_message("thr_a", "two", Some(host.clone()))).unwrap();
    let third = insert_queued_message(
        &db,
        new_message("thr_a", "three", Some(QueuedMessageWaitingOn::Time)),
    )
    .unwrap();
    let rows = list_queued_messages(&db, "thr_a").unwrap();
    let order: Vec<&str> = rows.iter().map(|row| row.id.as_str()).collect();
    assert_eq!(order, [first.id.as_str(), second.id.as_str(), third.id.as_str()]);
    assert!(first.sort_key < second.sort_key && second.sort_key < third.sort_key);
    assert_eq!(parse_queued_wait(&rows[0]).unwrap(), None);
    assert_eq!(parse_queued_wait(&rows[1]).unwrap(), Some(host));
    assert_eq!(
        rows[1].waiting_on.as_deref(),
        Some(r#"{"kind":"host-offline","hostName":"Laptop"}"#)
    );

    let message = to_thread_queued_message(&rows[1]).unwrap();
    let encoded = serde_json::to_value(&message).unwrap();
    assert_eq!(encoded["initiator"], "user");
    assert_eq!(encoded["editable"], true);
    assert_eq!(encoded["groupWithNext"], false);
    assert_eq!(encoded["payload"], json!({ "kind": "inline" }));
    assert_eq!(encoded["waitingOn"], json!({ "kind": "host-offline", "hostName": "Laptop" }));
    assert_eq!(encoded["content"], json!([{ "type": "text", "text": "two" }]));

    let plugin =
        QueuedMessageWaitingOn::Plugin { plugin_id: "tasks".into(), reason: "Blocked".into() };
    set_queued_message_wait(&db, &rows[..1], Some(&plugin)).unwrap();
    let updated = get_queued_message(&db, "thr_a", &first.id).unwrap().unwrap();
    assert!(updated.updated_at > first.updated_at);
    assert_eq!(parse_queued_wait(&updated).unwrap(), Some(plugin));
    assert_eq!(
        list_thread_ids_waiting_on(&db, QueuedMessageWaitingOnKind::Plugin, None).unwrap(),
        ["thr_a"]
    );
    assert!(
        list_thread_ids_waiting_on(&db, QueuedMessageWaitingOnKind::Stopping, None)
            .unwrap()
            .is_empty()
    );

    update_queued_message_content(&db, &updated, &[json!({ "type": "text", "text": "edited" })])
        .unwrap();
    let edited = get_queued_message(&db, "thr_a", &first.id).unwrap().unwrap();
    assert_eq!(parse_queued_content(&edited).unwrap()[0]["text"], "edited");

    delete_queued_messages(&db, &[first.id.clone(), third.id.clone()]).unwrap();
    assert_eq!(list_queued_messages(&db, "thr_a").unwrap().len(), 1);
    let error = queued_message_not_found();
    assert_eq!((error.status, error.code()), (404, "invalid_request"));
    assert_eq!(error.body.message, "Queued message not found");
}

#[test]
fn legacy_rows_and_time_waits() {
    let db = seeded();
    insert(
        &db,
        "queued_thread_messages",
        row! {
            "id" => "qmsg_legacy", "threadId" => "thr_a",
            "content" => r#"[{"type":"text","text":"old"}]"#, "senderThreadId" => "thr_parent",
            "model" => "gpt-5", "reasoningLevel" => "medium", "permissionMode" => "full",
            "serviceTier" => "default", "sendAt" => 500, "waitingOn" => (),
            "failureReason" => "Host went away", "sortKey" => "a0", "createdAt" => 1, "updatedAt" => 1,
        },
    );
    let row = get_queued_message(&db, "thr_a", "qmsg_legacy").unwrap().unwrap();
    let message = to_thread_queued_message(&row).unwrap();
    assert_eq!(message.waiting_on, None);
    assert_eq!(message.initiator, QueuedMessageInitiator::Agent);
    assert_eq!(message.failure_reason.as_deref(), Some("Host went away"));

    let mut timed = new_message("thr_a", "later", Some(QueuedMessageWaitingOn::Time));
    timed.send_at = Some(2_000_000);
    insert_queued_message(&db, timed).unwrap();
    let kind = QueuedMessageWaitingOnKind::Time;
    assert!(list_thread_ids_waiting_on(&db, kind, Some(1_000)).unwrap().is_empty());
    assert_eq!(list_thread_ids_waiting_on(&db, kind, Some(2_000_000)).unwrap(), ["thr_a"]);
    assert_eq!(list_thread_ids_waiting_on(&db, kind, None).unwrap(), ["thr_a"]);

    let mut system = new_message("thr_a", "notice", None);
    system.system_notice =
        Some(QueuedMessageSystemNotice { kind: SystemMessageKind::ChildCompleted, subject: None });
    let stored = insert_queued_message(&db, system).unwrap();
    assert_eq!(queued_initiator(&stored), QueuedMessageInitiator::System);
    assert_eq!(
        parse_queued_notice(&stored).unwrap().unwrap().kind,
        SystemMessageKind::ChildCompleted
    );

    let counts = list_queue_counts(&db, &["thr_a".into()]).unwrap();
    assert_eq!((counts[0].queued, counts[0].failed), (3, 1));
}

#[test]
fn invalid_waits_and_empty_content_fail_to_parse() {
    let db = seeded();
    let row = insert_queued_message(&db, new_message("thr_a", "x", None)).unwrap();
    let mut broken = row.clone();
    broken.waiting_on = Some(r#"{"kind":"host-offline","hostName":""}"#.into());
    assert!(parse_queued_wait(&broken).is_err());
    broken.waiting_on = Some(r#"{"kind":"nap"}"#.into());
    assert!(parse_queued_wait(&broken).is_err());
    broken.content = "[]".into();
    assert!(parse_queued_content(&broken).is_err());
}

fn provider_interaction(thread_id: &str, request: &str) -> NewPendingInteraction {
    NewPendingInteraction {
        thread_id: thread_id.into(),
        origin_kind: PendingInteractionOriginKind::Provider,
        turn_id: None,
        provider_id: Some("codex".into()),
        provider_thread_id: Some("ptid".into()),
        provider_request_id: Some(request.into()),
        plugin_id: None,
        renderer_id: None,
        payload: json!({ "kind": "approval", "title": "Run ls" }),
    }
}

#[test]
fn interactions_move_through_statuses() {
    use PendingInteractionStatus::*;
    let db = seeded();
    let row = insert_pending_interaction(&db, provider_interaction("thr_a", "req_1")).unwrap();
    assert_eq!(row.status, Pending);
    assert!(has_turn_bound_interaction(&db, "thr_a").unwrap());
    assert_eq!(find_provider_interaction(&db, "thr_a", "req_1").unwrap().unwrap().id, row.id);
    assert_eq!(find_thread_list_row(&db, "thr_a").unwrap().unwrap().has_pending_interaction, 1);

    let settle = |from: &[PendingInteractionStatus], status, resolution| {
        let next = InteractionSettlement { status, status_reason: None, resolution };
        settle_interaction(&db, &row.id, from, next).unwrap()
    };
    let resolving =
        settle(&[Pending], Resolving, Some(json!({ "decision": "allow_once" }))).unwrap();
    assert_eq!((resolving.status, resolving.resolved_at), (Resolving, None));
    assert_eq!(find_thread_list_row(&db, "thr_a").unwrap().unwrap().has_pending_interaction, 0);
    assert_eq!(list_active_interactions(&db, "thr_a").unwrap().len(), 1);
    assert!(settle(&[Pending], Resolved, None).is_none());
    let resolved = settle(&[Pending, Resolving], Resolved, None).unwrap();
    assert!(resolved.resolved_at.is_some());
    assert_eq!(resolved.resolution, resolving.resolution);
    assert!(list_active_interactions(&db, "thr_a").unwrap().is_empty());
    assert!(!has_turn_bound_interaction(&db, "thr_a").unwrap());

    let entity = serde_json::to_value(to_pending_interaction(&resolved).unwrap()).unwrap();
    let keys: Vec<&str> = entity.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        [
            "id",
            "threadId",
            "status",
            "statusReason",
            "createdAt",
            "expiresAt",
            "resolvedAt",
            "turnId",
            "providerId",
            "providerThreadId",
            "providerRequestId",
            "origin",
            "payload",
            "resolution",
        ]
    );
    assert_eq!(entity["turnId"], "none");
    assert_eq!(
        entity["origin"],
        json!({
            "kind": "provider", "providerId": "codex", "providerThreadId": "ptid", "providerRequestId": "req_1"
        })
    );
    assert_eq!(entity["resolution"], json!({ "decision": "allow_once" }));

    let duplicate = insert_pending_interaction(&db, provider_interaction("thr_a", "req_1"));
    assert!(duplicate.unwrap_err().is_constraint());
}

#[test]
fn plugin_interactions_have_plugin_origin() {
    let db = seeded();
    let input = NewPendingInteraction {
        thread_id: "thr_a".into(),
        origin_kind: PendingInteractionOriginKind::Plugin,
        turn_id: None,
        provider_id: None,
        provider_thread_id: None,
        provider_request_id: None,
        plugin_id: Some("ask-user-question".into()),
        renderer_id: Some("question".into()),
        payload: json!({ "kind": "plugin", "title": "Pick" }),
    };
    let row = insert_pending_interaction(&db, input).unwrap();
    assert_eq!(list_active_plugin_interactions(&db).unwrap().len(), 1);
    assert!(!has_turn_bound_interaction(&db, "thr_a").unwrap());
    let entity = to_pending_interaction(&row).unwrap();
    assert!(entity.is_plugin());
    let encoded = serde_json::to_value(&entity).unwrap();
    assert_eq!(encoded["turnId"], serde_json::Value::Null);
    assert!(encoded.get("providerId").is_none());
    assert_eq!(
        encoded["origin"],
        json!({ "kind": "plugin", "pluginId": "ask-user-question", "rendererId": "question" })
    );
}

#[test]
fn list_filters() {
    let db = seeded();
    insert(
        &db,
        "hosts",
        row! { "id" => "hst_1", "name" => "Box", "createdAt" => 1, "updatedAt" => 1 },
    );
    insert(
        &db,
        "environments",
        row! {
            "id" => "env_1", "projectId" => "prj_a", "hostId" => "hst_1", "branchName" => "main",
            "isWorktree" => 1, "status" => "ready", "createdAt" => 1, "updatedAt" => 1,
        },
    );
    insert(
        &db,
        "thread_sections",
        row! { "id" => "sec_1", "name" => "Later", "createdAt" => 1, "updatedAt" => 1 },
    );
    thread(&db, "thr_b", "prj_a", 20, row! { "environmentId" => "env_1", "sectionId" => "sec_1" });
    thread(&db, "thr_c", "prj_a", 30, row! { "parentThreadId" => "thr_a", "originKind" => "fork" });
    thread(&db, "thr_d", "prj_a", 40, row! { "archivedAt" => 50, "originPluginId" => "tasks" });
    thread(&db, "thr_e", "prj_b", 50, row! { "visibility" => "hidden" });
    thread(&db, "thr_f", "prj_a", 60, row! { "deletedAt" => 70 });
    thread(&db, "thr_p", "prj_a", 5, row! { "pinnedAt" => 9, "pinSortKey" => "a0" });

    let list = |query: ThreadListQuery| list_thread_rows(&db, &query).unwrap();
    let all = list(ThreadListQuery::default());
    assert_eq!(ids(&all), ["thr_p", "thr_d", "thr_c", "thr_b", "thr_a"]);
    let flag = Some(QueryFlag::True);
    let off = Some(QueryFlag::False);
    let q = ThreadListQuery::default;
    assert_eq!(
        ids(&list(ThreadListQuery { project_id: Some("prj_b".into()), ..q() })),
        Vec::<&str>::new()
    );
    assert_eq!(
        ids(&list(ThreadListQuery {
            project_id: Some("prj_b".into()),
            include_hidden: flag,
            ..q()
        })),
        ["thr_e"]
    );
    let by_env = list(ThreadListQuery { environment_id: Some("env_1".into()), ..q() });
    assert_eq!(ids(&by_env), ["thr_b"]);
    assert_eq!(by_env[0].environment_branch_name.as_deref(), Some("main"));
    assert_eq!(by_env[0].environment_is_worktree, Some(1));
    assert_eq!(ids(&list(ThreadListQuery { host_id: Some("hst_1".into()), ..q() })), ["thr_b"]);
    assert_eq!(
        ids(&list(ThreadListQuery { parent_thread_id: Some("thr_a".into()), ..q() })),
        ["thr_c"]
    );
    assert_eq!(ids(&list(ThreadListQuery { section_id: Some("sec_1".into()), ..q() })), ["thr_b"]);
    assert_eq!(
        ids(&list(ThreadListQuery { unsectioned: flag, ..q() })),
        ["thr_p", "thr_d", "thr_c", "thr_a"]
    );
    assert_eq!(ids(&list(ThreadListQuery { has_parent: flag, ..q() })), ["thr_c"]);
    assert_eq!(
        ids(&list(ThreadListQuery { has_parent: off, archived: off, ..q() })),
        ["thr_p", "thr_b", "thr_a"]
    );
    assert_eq!(
        ids(&list(ThreadListQuery { origin_kind: Some(ThreadOriginKind::Fork), ..q() })),
        ["thr_c"]
    );
    assert_eq!(
        ids(&list(ThreadListQuery { origin_plugin_id: Some("tasks".into()), ..q() })),
        ["thr_d"]
    );
    assert_eq!(ids(&list(ThreadListQuery { archived: flag, ..q() })), ["thr_d"]);
    let page = ThreadListQuery { limit: Some("2".into()), offset: Some("1".into()), ..q() };
    assert_eq!(ids(&list(page)), ["thr_d", "thr_c"]);

    assert_eq!(ids(&list_sidebar_thread_rows(&db).unwrap()), ["thr_p", "thr_c", "thr_b", "thr_a"]);
    let by_ids =
        list_thread_rows_by_ids(&db, &["thr_b".into(), "thr_f".into(), "thr_e".into()]).unwrap();
    assert_eq!(by_ids.len(), 2);
    let mentions = list_thread_mention_rows(&db, &["thr_a".into(), "thr_f".into()]).unwrap();
    assert_eq!(mentions.len(), 1);
    assert_eq!(mentions[0].project_id, "prj_a");
    let summary = thread_child_summary(&db, "thr_a").unwrap();
    assert_eq!((summary.non_deleted_child_count, summary.unarchived_descendant_count), (1, 1));
}

#[test]
fn prompt_history_skips_invalid_input() {
    let db = seeded();
    let entry = |id: &str, scope: &str, sequence: i64, input: &str| {
        insert(
            &db,
            "prompt_history_entries",
            row! {
                "id" => id, "projectId" => "prj_a", "threadId" => "thr_a", "scope" => scope,
                "requestSequence" => sequence, "input" => input, "createdAt" => 5,
            },
        );
    };
    entry("h1", "project", 1, r#"[{"type":"text","text":"a"}]"#);
    entry("h2", "project", 2, "[]");
    entry("h3", "project", 3, r#"[{"type":"text","text":"c"}]"#);
    entry("h4", "thread", 4, r#"[{"type":"text","text":"d"}]"#);
    let project =
        list_prompt_history_entries(&db, PromptHistoryScope::Project("prj_a"), 10).unwrap();
    assert_eq!(project.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["h3", "h1"]);
    let thread = list_prompt_history_entries(&db, PromptHistoryScope::Thread("thr_a"), 10).unwrap();
    assert_eq!(
        serde_json::to_value(&thread).unwrap(),
        json!([{ "id": "h4", "createdAt": 5, "input": [{ "type": "text", "text": "d" }] }])
    );
}

fn segment(db: &Db, id: &str, thread_id: &str, kind: &str, seq: Option<i64>, text: &str) {
    insert(
        db,
        "thread_search_segments",
        row! {
            "id" => id, "threadId" => thread_id, "sourceKind" => kind, "sourceKey" => id,
            "sourceSeq" => seq, "text" => text, "createdAt" => 1, "updatedAt" => 1,
        },
    );
}

#[test]
fn search_matches_user_and_assistant_segments() {
    let db = seeded();
    thread(&db, "thr_b", "prj_a", 20, row! { "archivedAt" => 30 });
    thread(&db, "thr_h", "prj_a", 20, row! { "visibility" => "hidden" });
    segment(&db, "s1", "thr_a", "title", None, "Fix the Café login");
    segment(&db, "s2", "thr_a", "user_message", Some(3), "please fix the cafe login redirect");
    let long =
        format!("{} the login bug lives in auth.ts {}", "word ".repeat(30), "tail ".repeat(30));
    segment(&db, "s3", "thr_b", "assistant_message", Some(7), &long);
    segment(&db, "s4", "thr_h", "user_message", Some(1), "login hidden");

    let result = search_threads(&db, "login", SEARCH_LIMIT_PER_GROUP_DEFAULT).unwrap();
    assert_eq!(result.active.total, 1);
    let hit = &result.active.hits[0];
    assert_eq!(hit.thread_id, "thr_a");
    assert_eq!(hit.matches.len(), 2);
    assert_eq!(hit.matches[0].source_kind, ThreadSearchSourceKind::Title);
    assert_eq!(hit.matches[0].highlight_ranges, [HighlightRange { start: 13, end: 18 }]);
    assert_eq!(hit.matches[1].source_seq, Some(3));

    let archived = &result.archived.hits[0];
    assert_eq!((result.archived.total, archived.thread_id.as_str()), (1, "thr_b"));
    let shown = &archived.matches[0];
    assert!(shown.text.starts_with('…') && shown.text.ends_with('…'));
    assert!(shown.text.encode_utf16().count() <= 162);
    let range = shown.highlight_ranges[0];
    let units: Vec<u16> = shown.text.encode_utf16().collect();
    assert_eq!(String::from_utf16(&units[range.start..range.end]).unwrap(), "login");

    let folded = search_threads(&db, "cafe log", 20).unwrap();
    let title = &folded.active.hits[0].matches[0];
    assert_eq!(
        title.highlight_ranges,
        [HighlightRange { start: 8, end: 12 }, HighlightRange { start: 13, end: 16 }]
    );
    let encoded = serde_json::to_value(title).unwrap();
    assert_eq!(
        encoded.as_object().unwrap().keys().collect::<Vec<_>>(),
        ["sourceKind", "text", "highlightRanges", "sourceSeq"]
    );

    assert!(search_threads(&db, "zzz login", 20).unwrap().active.hits.is_empty());
    assert_eq!(search_threads(&db, "!!", 20).unwrap(), ThreadSearchResult::default());
}

#[test]
fn search_ranks_threads_and_returns_highlight_ranges() {
    let db = seeded();
    thread(&db, "thr_2", "prj_a", 20, row! { "title" => "Notes", "archivedAt" => 5 });
    let filler = "lorem ipsum dolor sit amet ".repeat(8);
    let long = format!("{filler}fix the déploy pipeline today {filler}");
    segment(&db, "seg_0", "thr_a", "title", Some(0), "Deploy pipeline");
    segment(&db, "seg_1", "thr_a", "user_message", Some(1), &long);
    segment(&db, "seg_2", "thr_2", "assistant_message", Some(2), "deploy notes");

    let found = search_threads(&db, "deploy pipe", 20).unwrap();
    assert_eq!(found.archived, ThreadSearchGroup::default());
    assert_eq!(found.active.total, 1);
    let matches = &found.active.hits[0].matches;
    let spans: Vec<(usize, usize)> =
        matches[0].highlight_ranges.iter().map(|range| (range.start, range.end)).collect();
    assert_eq!(spans, [(0, 6), (7, 11)]);
    let units: Vec<u16> = matches[1].text.encode_utf16().collect();
    let marked: Vec<String> = matches[1]
        .highlight_ranges
        .iter()
        .map(|range| String::from_utf16(&units[range.start..range.end]).unwrap())
        .collect();
    assert_eq!(marked, ["déploy", "pipe"]);
    assert!(matches[1].text.starts_with('…') && matches[1].text.ends_with('…'));
    assert!((3..=162).contains(&units.len()));

    let broad = search_threads(&db, "deploy", 20).unwrap();
    let archived: Vec<&str> =
        broad.archived.hits.iter().map(|hit| hit.thread_id.as_str()).collect();
    assert_eq!(archived, ["thr_2"]);
}
