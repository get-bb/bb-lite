#[path = "timeline_window_support.rs"]
mod support;

use bb_server::db::Db;
use bb_server::db::event_read::{
    EventOutputs, RecentCache, context_clear_sequence, latest_sequence,
};
use bb_server::threads::timeline::*;
use bb_server::threads::timeline_pages::{
    TimelinePage, TimelinePaginationCursor, bind_cursor, snapshot_from_cursor,
};
use serde_json::{Value, json};
use support::*;

fn fixture(name: &str) -> (Db, bb_server::db::thread_read::ThreadListRow) {
    let (_, value) = fixtures().into_iter().find(|(n, _)| n == name).unwrap();
    let db = open();
    let thread = load_fixture(&db, &value);
    (db, thread)
}

fn epoch(db: &Db, thread_id: &str) -> Epoch {
    let max_seq = latest_sequence(db, thread_id).unwrap();
    Epoch {
        db: db.clone(),
        thread_id: thread_id.into(),
        start: context_clear_sequence(db, thread_id, max_seq).unwrap().unwrap_or(0),
        max_seq,
        exclude_diagnostics: true,
        outputs: EventOutputs::Inline,
    }
}

fn sequences(rows: &[bb_server::db::event_read::StoredEventRow]) -> Vec<i64> {
    rows.iter().map(|row| row.sequence).collect()
}

#[test]
fn window_start_follows_hints_and_budget() {
    assert_eq!(window_start(&[30, 20, 10], None, 5, 0), 0);
    assert_eq!(window_start(&[30, 20, 10], None, 2, 0), 20);
    assert_eq!(window_start(&[30, 20, 10], Some(15), 5, 0), 20);
    assert_eq!(window_start(&[30, 20, 10], Some(35), 5, 0), 30);
    assert_eq!(window_start(&[], Some(12), 5, 0), 12);
    assert_eq!(window_start(&[], None, 5, 7), 7);
}

#[test]
fn latest_window_loads_every_turn_and_its_context() {
    let (db, thread) = fixture("basic");
    let epoch = epoch(&db, &thread.thread.id);
    let window = load_window(&epoch, -1, epoch.max_seq + 1, true).unwrap();
    let seqs = sequences(&window.rows);
    assert!(seqs.windows(2).all(|pair| pair[0] < pair[1]));
    assert!(seqs.iter().all(|seq| *seq <= epoch.max_seq));
    assert!(!seqs.contains(&10), "diagnostic provider.env-resolved is excluded");
    for seq in [1, 11, 12, 18, 19, 20] {
        assert!(seqs.contains(&seq), "missing {seq} in {seqs:?}");
    }
    assert!(window.context_only_interruptions.is_empty());
}

#[test]
fn before_anchor_window_pulls_whole_turns_and_their_requests() {
    let (db, thread) = fixture("basic");
    let epoch = epoch(&db, &thread.thread.id);
    let window = load_window(&epoch, 12, 16, false).unwrap();
    let seqs = sequences(&window.rows);
    assert!(seqs.contains(&11), "turn start of an owned turn: {seqs:?}");
    assert!(seqs.contains(&18), "turn completion of an owned turn: {seqs:?}");
    assert!(seqs.contains(&1), "the request accepted by the turn: {seqs:?}");
    assert!(!seqs.contains(&20), "a later turn stays out: {seqs:?}");
    assert!(window.head_state_rows.is_empty());
}

#[test]
fn grouping_context_maps_accepted_requests_to_turns() {
    let (db, thread) = fixture("steer");
    let context = grouping_context(&epoch(&db, &thread.thread.id)).unwrap();
    assert!(context.accepted_turn_ids.values().any(|turn| turn.ends_with("-t1")));
    assert!(context.accepted_turn_ids.values().any(|turn| turn.ends_with("-t2")));
}

#[test]
fn select_page_rejects_a_vanished_anchor_and_bounds_the_window() {
    let (db, thread) = fixture("basic");
    let epoch = epoch(&db, &thread.thread.id);
    let cursor = TimelinePaginationCursor { anchor_seq: 999, anchor_id: "x".into() };
    let page = TimelinePage::Older { segment_limit: 2, before_cursor: cursor };
    let error = select_page(&epoch, &page, 1_500, None).err().unwrap();
    assert_eq!(error.body.message, "Timeline pagination cursor is no longer available");
    let latest = TimelinePage::Latest { segment_limit: 1 };
    let selection = select_page(&epoch, &latest, 1_500, None).unwrap();
    assert_eq!(selection.owned_sequence_end, epoch.max_seq + 1);
    assert_eq!(selection.owned_sequence_start, 19);
    assert_eq!(selection.known_has_older_segments, Some(true));
    let budgeted = select_page(&epoch, &TimelinePage::Latest { segment_limit: 20 }, 3, None);
    assert!(budgeted.unwrap().owned_sequence_start > 1);
}

#[test]
fn epochs_start_at_the_last_completed_context_clear() {
    let db = open();
    insert_thread(&db, "thr_clear", "idle", Some("T"), None);
    let scope = json!({ "kind": "thread" });
    append(
        &db,
        "thr_clear",
        json!({ "type": "client/turn/requested", "scope": scope, "requestId": "r1" }),
    );
    let clear = json!({ "type": "system/operation", "scope": scope,
        "operation": "context_clear", "status": "completed" });
    let cleared = append(&db, "thr_clear", clear);
    append(
        &db,
        "thr_clear",
        json!({ "type": "client/turn/requested", "scope": scope, "requestId": "r2" }),
    );
    let epoch = epoch(&db, "thr_clear");
    assert_eq!(epoch.start, cleared);
    let window = load_window(&epoch, epoch.start - 1, epoch.max_seq + 1, false).unwrap();
    assert!(!sequences(&window.rows).contains(&1));
}

#[test]
fn cursors_bind_to_the_surface() {
    let (db, thread) = fixture("basic");
    let request = request_for(&json!({}));
    let surface = timeline_surface(&thread, &request);
    let parsed: Value = serde_json::from_str(&surface).unwrap();
    assert_eq!(parsed[2], 32_000);
    assert_eq!(parsed[3], "Echo");
    assert_eq!(parsed[6], "collapse");
    let snapshot = bb_server::threads::timeline_pages::TimelineSnapshot {
        version: 3,
        thread_id: thread.thread.id.clone(),
        max_seq: latest_sequence(&db, &thread.thread.id).unwrap(),
        status: thread.thread.status,
        surface: surface.clone(),
    };
    let anchor = TimelinePaginationCursor { anchor_seq: 19, anchor_id: "row".into() };
    let bound = bind_cursor(Some(&anchor), &snapshot, None).unwrap();
    let (decoded, content) = snapshot_from_cursor(&bound, &thread.thread.id, &surface).unwrap();
    assert_eq!((decoded, content), (snapshot, None));
    let nested = TimelineRequest { include_nested_rows: true, ..request };
    assert!(
        snapshot_from_cursor(&bound, &thread.thread.id, &timeline_surface(&thread, &nested))
            .is_err()
    );
}

#[test]
fn cache_keys_cover_page_display_and_thread_facts() {
    let (_, thread) = fixture("basic");
    let base = request_for(&json!({}));
    let key = timeline_cache_key(&thread, &base);
    assert!(key.starts_with(&format!("{}|", thread.thread.id)));
    assert_eq!(key, timeline_cache_key(&thread, &base.clone()));
    let after = TimelineRequest { after_sequence: Some(3), ..base.clone() };
    assert_eq!(key, timeline_cache_key(&thread, &after), "afterSequence is not part of the key");
    let paged = request_for(&json!({ "segmentLimit": "2" }));
    assert_ne!(key, timeline_cache_key(&thread, &paged));
    let mut renamed = thread.clone();
    renamed.thread.title = Some("other".into());
    assert_ne!(key, timeline_cache_key(&renamed, &base));
    let mut moved = thread.clone();
    moved.environment_path = Some("/elsewhere".into());
    assert_ne!(key, timeline_cache_key(&moved, &base));
}

#[test]
fn cache_eviction_keeps_32_keys_and_forgets_threads() {
    let cache: RecentCache<u32> = RecentCache::new(SERVED_KEY_LIMIT);
    for index in 0..40 {
        cache.remember(&format!("thr_{}|{index}", index % 2), index);
    }
    assert_eq!(cache.len(), 32);
    assert!(cache.get("thr_0|0").is_none());
    assert_eq!(cache.get("thr_1|39"), Some(39));
    cache.remove_where(|key| key.starts_with("thr_1|"));
    assert_eq!(cache.len(), 16);
    let reader = TimelineReader::new(open());
    reader.forget_thread("thr_1");
    assert_eq!(reader.cached_key_count(), 0);
}

#[test]
fn deltas_upsert_changed_rows_and_report_reordering() {
    let a = json!({ "id": "a", "text": "1" });
    let b = json!({ "id": "b", "text": "2" });
    let b2 = json!({ "id": "b", "text": "3" });
    let c = json!({ "id": "c" });
    assert_eq!(
        compute_row_delta(&[a.clone(), b.clone()], &[a.clone(), b.clone()]),
        json!({ "upsertRows": [] })
    );
    assert_eq!(
        compute_row_delta(&[a.clone(), b.clone()], &[a.clone(), b2.clone()]),
        json!({ "upsertRows": [b2] })
    );
    assert_eq!(
        compute_row_delta(&[a.clone(), b.clone()], &[a.clone(), b.clone(), c.clone()]),
        json!({ "upsertRows": [c], "rowOrder": ["a", "b", "c"] })
    );
    assert_eq!(
        compute_row_delta(&[a.clone(), b.clone()], &[b, a]),
        json!({ "upsertRows": [], "rowOrder": ["b", "a"] })
    );
}

#[test]
fn rows_after_the_ordering_boundary_sort_by_sequence() {
    let row = |id: &str, start: i64, end: i64| json!({ "id": id, "sourceSeqStart": start, "sourceSeqEnd": end });
    let rows = vec![row("x", 5, 9), row("a", 1, 2), row("c", 8, 8), row("b", 6, 7)];
    let ordered = order_from_boundary(rows.clone(), Some(6));
    let ids: Vec<&str> = ordered.iter().map(|r| r["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["x", "a", "b", "c"]);
    assert_eq!(order_from_boundary(rows.clone(), None), rows);
}

#[tokio::test]
async fn turn_details_reject_inverted_ranges() {
    let (db, thread) = fixture("basic");
    let request = TurnDetailsRequest {
        display: display(),
        turn_id: "t".into(),
        source_seq_start: 5,
        source_seq_end: 4,
        before_cursor: None,
    };
    let error = read_turn_summary_details(&db, &thread, &request).await.unwrap_err();
    assert_eq!(error.body.message, "sourceSeqStart must be less than or equal to sourceSeqEnd");
}

#[tokio::test]
async fn the_projection_cache_stays_within_its_byte_budget() {
    let (_, fixture) = fixtures().into_iter().next().unwrap();
    let variants = [json!({}), json!({ "segmentLimit": "2" }), json!({ "summaryOnly": "true" })];

    let db = open();
    let thread = load_fixture(&db, &fixture);
    let roomy = TimelineReader::new(db);
    for query in &variants {
        roomy.read_thread_timeline(&thread, &request_for(query)).await.unwrap();
    }
    assert_eq!(roomy.cached_key_count(), 3);
    let held = roomy.memory()["approxBytes"].as_u64().unwrap();
    assert!(held > 0);

    let db = open();
    let thread = load_fixture(&db, &fixture);
    let tight = TimelineReader::with_byte_budget(db, 1);
    for query in &variants {
        tight.read_thread_timeline(&thread, &request_for(query)).await.unwrap();
    }
    assert_eq!(tight.cached_key_count(), 1);
    let first = request_for(&variants[2]);
    let again = tight.read_thread_timeline(&thread, &first).await.unwrap();
    let before = tight.read_thread_timeline(&thread, &first).await.unwrap();
    assert!(std::sync::Arc::ptr_eq(&again, &before));
}
