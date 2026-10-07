mod engine_create_support;

use bb_server::db::queued_messages::get_queued_message;
use bb_server::db::thread_sections::create_thread_section;
use bb_server::db::threads::get_thread;
use bb_server::domain::changes::ThreadChangeKind;
use bb_server::error::ApiError;
use bb_server::threads::create::{CreateThreadRequest, create_thread, require_valid_parent};
use bb_server::threads::mutations::{
    self, CreateQueuedMessageRequest, ReorderPinnedThreadRequest, UpdateQueuedMessageRequest,
    UpdateThreadRequest,
};
use bb_server::threads::provisioning::derive_title_fallback;
use engine_create_support::{Harness, PROJECT};
use serde_json::{Value, json};

fn text(value: &str) -> Value {
    json!({ "type": "text", "text": value })
}

fn request(extra: Value) -> CreateThreadRequest {
    let mut base = json!({
        "projectId": PROJECT,
        "origin": "app",
        "input": [text("hello")],
        "environment": { "type": "project-default" },
    });
    for (key, value) in extra.as_object().unwrap() {
        base[key] = value.clone();
    }
    serde_json::from_value(base).unwrap()
}

fn message(error: ApiError) -> String {
    error.to_string()
}

fn reason(error: &ApiError) -> String {
    assert_eq!(error.body.code, "parent_thread_invalid", "{error:?}");
    let details = error.body.details.clone().unwrap_or_default();
    assert_eq!(details["subject"], "parent");
    details["reason"].as_str().unwrap_or_default().to_owned()
}

#[test]
fn validate_encodes_the_create_request_refinements() {
    let cases = [
        (json!({ "origin": "plugin" }), "originPluginId is required when origin is \"plugin\""),
        (json!({ "originPluginId": "demo" }), "originPluginId requires origin \"plugin\""),
        (json!({ "pluginMetadata": {} }), "pluginMetadata requires origin \"plugin\""),
        (
            json!({ "origin": "plugin", "originPluginId": "Bad_Id", "pluginMetadata": {} }),
            "pluginMetadata requires originPluginId to be a valid plugin id",
        ),
        (json!({ "input": [] }), "input must contain at least one entry"),
    ];
    for (extra, expected) in cases {
        let error = request(extra).validate().unwrap_err();
        assert_eq!(message(error), expected);
    }
    let plugin = json!({ "origin": "plugin", "originPluginId": "my-plugin", "pluginMetadata": {} });
    request(plugin).validate().unwrap();
    request(json!({})).validate().unwrap();
}

#[test]
fn title_fallback_matches_the_typescript_derivation() {
    assert_eq!(derive_title_fallback(&[]), None);
    assert_eq!(derive_title_fallback(&[text("   ")]), None);
    let image = json!({ "type": "image", "url": "x" });
    let input = [text("  fix   the\n bug "), image, text("\tplease ")];
    assert_eq!(derive_title_fallback(&input).as_deref(), Some("fix the bug please"));
    let exact = "a".repeat(80);
    assert_eq!(derive_title_fallback(&[text(&exact)]), Some(exact));
    let long = "b".repeat(81);
    let expected = format!("{}...", "b".repeat(77));
    assert_eq!(derive_title_fallback(&[text(&long)]), Some(expected));
}

#[test]
fn parents_must_exist_be_live_acyclic_and_shallow() {
    let h = Harness::new();
    let db = &h.ctx.db;
    let error = require_valid_parent(db, "thr_missing", None).unwrap_err();
    assert_eq!(reason(&error), "not_found");
    let root = h.thread(None);
    let a = h.thread(Some(&root.id));
    let b = h.thread(Some(&a.id));
    let c = h.thread(Some(&b.id));
    let d = h.thread(Some(&c.id));
    assert_eq!(require_valid_parent(db, &root.id, None).unwrap().id, root.id);
    assert_eq!(reason(&require_valid_parent(db, &d.id, None).unwrap_err()), "too_deep");
    assert_eq!(reason(&require_valid_parent(db, &root.id, Some(&root)).unwrap_err()), "self");
    assert_eq!(reason(&require_valid_parent(db, &a.id, Some(&root)).unwrap_err()), "cycle");
    let archived = h.thread(None);
    h.set(&archived.id, "archived_at", "5");
    let error = require_valid_parent(db, &archived.id, None).unwrap_err();
    assert_eq!(reason(&error), "archived");
}

#[tokio::test]
async fn create_rejects_bad_requests_before_inserting() {
    let h = Harness::new();
    let error = create_thread(&h.ctx, request(json!({ "input": [] }))).await.unwrap_err();
    assert_eq!(message(error), "input must contain at least one entry");
    let reuse = json!({ "environment": { "type": "reuse", "environmentId": "env_nope" } });
    let error = create_thread(&h.ctx, request(reuse)).await.unwrap_err();
    assert_eq!(message(error), "Environment not found");
    let provider = json!({ "environment": { "type": "provider", "environmentProviderId": "x" } });
    let error = create_thread(&h.ctx, request(provider)).await.unwrap_err();
    assert_eq!(message(error), "unknown environment provider");
    let parent = json!({ "parentThreadId": "thr_missing" });
    let error = create_thread(&h.ctx, request(parent)).await.unwrap_err();
    assert_eq!(reason(&error), "not_found");
    let count: Option<i64> = h.ctx.db.scalar("SELECT COUNT(*) FROM threads", []).unwrap();
    assert_eq!(count, Some(0));
}

#[test]
fn update_patches_fields_and_announces_changes() {
    let h = Harness::new();
    let parent = h.thread(None);
    let thread = h.thread(None);
    h.take_thread_changes(&thread.id);
    let section = create_thread_section(&h.ctx.db, "Work").unwrap();
    let patch: UpdateThreadRequest = serde_json::from_value(json!({
        "title": "Renamed",
        "sectionId": section.id,
        "parentThreadId": parent.id,
        "model": "gpt-x",
    }))
    .unwrap();
    mutations::update(&h.ctx, &thread.id, patch).unwrap();
    let row = get_thread(&h.ctx.db, &thread.id).unwrap().unwrap();
    assert_eq!(row.title.as_deref(), Some("Renamed"));
    assert_eq!(row.parent_thread_id.as_deref(), Some(parent.id.as_str()));
    assert_eq!(row.model_override.as_deref(), Some("gpt-x"));
    let project = Some(PROJECT.to_owned());
    assert_eq!(
        h.take_thread_changes(&thread.id),
        vec![
            (ThreadChangeKind::TitleChanged, project.clone()),
            (ThreadChangeKind::ParentChanged, project)
        ]
    );
    let clear: UpdateThreadRequest = serde_json::from_value(json!({ "title": null })).unwrap();
    mutations::update(&h.ctx, &thread.id, clear).unwrap();
    assert_eq!(get_thread(&h.ctx.db, &thread.id).unwrap().unwrap().title, None);
    let same: UpdateThreadRequest =
        serde_json::from_value(json!({ "parentThreadId": parent.id })).unwrap();
    mutations::update(&h.ctx, &thread.id, same).unwrap();
    h.take_thread_changes(&thread.id);
    let looped: UpdateThreadRequest =
        serde_json::from_value(json!({ "parentThreadId": thread.id })).unwrap();
    let error = mutations::update(&h.ctx, &parent.id, looped).unwrap_err();
    assert_eq!(reason(&error), "cycle");
}

#[test]
fn pin_read_and_reorder_mutations() {
    let h = Harness::new();
    let first = h.thread(None);
    let second = h.thread(None);
    h.tick(10);
    mutations::pin(&h.ctx, &first.id).unwrap();
    mutations::pin(&h.ctx, &second.id).unwrap();
    let row = get_thread(&h.ctx.db, &first.id).unwrap().unwrap();
    assert_eq!(row.pinned_at, Some(1_010));
    let key = row.pin_sort_key.clone();
    mutations::pin(&h.ctx, &first.id).unwrap();
    assert_eq!(get_thread(&h.ctx.db, &first.id).unwrap().unwrap().pin_sort_key, key);
    let project = Some(PROJECT.to_owned());
    let pinned = (ThreadChangeKind::PinStateChanged, project.clone());
    assert_eq!(h.take_thread_changes(&first.id), vec![pinned.clone(), pinned.clone()]);
    let reorder = ReorderPinnedThreadRequest {
        previous_thread_id: None,
        next_thread_id: Some(first.id.clone()),
    };
    let order = mutations::reorder_pinned(&h.ctx, &second.id, reorder).unwrap();
    let ids: Vec<Value> =
        order.iter().map(|entry| serde_json::to_value(entry).unwrap()["id"].clone()).collect();
    assert_eq!(ids, vec![json!(second.id), json!(first.id)]);
    mutations::unpin(&h.ctx, &first.id).unwrap();
    assert_eq!(get_thread(&h.ctx.db, &first.id).unwrap().unwrap().pinned_at, None);
    h.take_thread_changes(&first.id);
    mutations::mark_read(&h.ctx, &first.id).unwrap();
    assert_eq!(get_thread(&h.ctx.db, &first.id).unwrap().unwrap().last_read_at, Some(1_010));
    mutations::mark_unread(&h.ctx, &first.id).unwrap();
    assert_eq!(get_thread(&h.ctx.db, &first.id).unwrap().unwrap().last_read_at, None);
    let read = (ThreadChangeKind::ReadStateChanged, project);
    assert_eq!(h.take_thread_changes(&first.id), vec![read.clone(), read]);
}

#[tokio::test]
async fn compact_requires_an_idle_or_errored_thread() {
    let h = Harness::new();
    let thread = h.thread(None);
    let error = mutations::compact(&h.ctx, &thread.id).await.unwrap_err();
    assert_eq!(message(error), "Context can only be compacted while the thread is idle or errored");
}

#[test]
fn queued_messages_create_update_and_delete() {
    let h = Harness::new();
    let thread = h.thread(None);
    h.take_thread_changes(&thread.id);
    let create = CreateQueuedMessageRequest {
        input: vec![text("later")],
        model: None,
        service_tier: None,
        reasoning_level: None,
        permission_mode: None,
        execution_input_sources: None,
        sender_thread_id: None,
    };
    let queued = mutations::create_queued_message(&h.ctx, &thread.id, create.clone()).unwrap();
    let id = queued["id"].as_str().unwrap().to_owned();
    assert_eq!(queued["waitingOn"], json!({ "kind": "thread-busy" }));
    let queue_changed = (ThreadChangeKind::QueueChanged, None);
    assert_eq!(h.take_thread_changes(&thread.id), vec![queue_changed.clone()]);
    let stale = UpdateQueuedMessageRequest { expected_updated_at: 1, input: vec![text("x")] };
    let error = mutations::update_queued_message(&h.ctx, &thread.id, &id, stale).unwrap_err();
    assert_eq!(message(error), "Queued message changed since editing began");
    let row = get_queued_message(&h.ctx.db, &thread.id, &id).unwrap().unwrap();
    h.tick(5);
    let fresh = UpdateQueuedMessageRequest {
        expected_updated_at: row.updated_at,
        input: vec![text("edited")],
    };
    let updated = mutations::update_queued_message(&h.ctx, &thread.id, &id, fresh).unwrap();
    assert_eq!(updated["content"], json!([text("edited")]));
    mutations::delete_queued_message(&h.ctx, &thread.id, &id).unwrap();
    assert!(get_queued_message(&h.ctx.db, &thread.id, &id).unwrap().is_none());
    assert!(mutations::delete_queued_message(&h.ctx, &thread.id, &id).is_err());
    assert_eq!(h.take_thread_changes(&thread.id), vec![queue_changed.clone(), queue_changed]);
    h.set(&thread.id, "status", "stopping");
    let queued = mutations::create_queued_message(&h.ctx, &thread.id, create.clone()).unwrap();
    assert_eq!(queued["waitingOn"], json!({ "kind": "stopping" }));
    let alias = CreateQueuedMessageRequest {
        permission_mode: Some("workspace-write".into()),
        ..create.clone()
    };
    let queued = mutations::create_queued_message(&h.ctx, &thread.id, alias).unwrap();
    let id = queued["id"].as_str().unwrap();
    let row = get_queued_message(&h.ctx.db, &thread.id, id).unwrap().unwrap();
    assert_eq!(row.permission_mode, "accept-edits");
    let bad = CreateQueuedMessageRequest { service_tier: Some("turbo".into()), ..create.clone() };
    assert!(mutations::create_queued_message(&h.ctx, &thread.id, bad).is_err());
    h.set(&thread.id, "archived_at", "9");
    let error = mutations::create_queued_message(&h.ctx, &thread.id, create).unwrap_err();
    assert_eq!(message(error), "Thread is archived");
}
