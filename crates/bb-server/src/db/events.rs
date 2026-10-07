use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::event_read::latest_sequence;
use super::threads::ThreadRow;
use super::{Db, DbResult, OnConflict, insert_row, new_id};
use crate::domain::events::{
    event_data, event_item, event_item_id, event_item_kind, event_parent_tool_call_id,
    event_provider_thread_id, event_scope_kind, event_turn_id, event_type,
};
use crate::row;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EventSource {
    Server,
    Runner,
}

const DELTA_TYPE_LIST: &str = "'item/agentMessage/delta', 'item/reasoning/textDelta', \
'item/reasoning/summaryTextDelta', 'item/plan/delta', 'item/fileChange/outputDelta', \
'item/commandExecution/outputDelta'";
const TERMINAL_ITEM_TYPES: [&str; 2] = ["item/completed", "item/backgroundTask/completed"];
const ORPHAN_DROPPABLE_TYPES: [&str; 2] =
    ["thread/tokenUsage/updated", "thread/contextWindowUsage/updated"];

fn has_turn_event(db: &Db, thread_id: &str, turn_id: &str, event_type: &str) -> DbResult<bool> {
    let rows = db.rows(
        "SELECT 1 FROM events WHERE thread_id = ? AND turn_id = ? AND type = ?",
        [thread_id, turn_id, event_type],
    )?;
    Ok(!rows.is_empty())
}

fn is_item_settled(db: &Db, thread_id: &str, item_id: &str) -> DbResult<bool> {
    let latest: Option<String> = db.scalar(
        "SELECT type FROM events
     WHERE thread_id = ? AND item_id = ? AND type IN
       ('item/started', 'item/completed', 'item/backgroundTask/completed')
     ORDER BY sequence DESC LIMIT 1",
        [thread_id, item_id],
    )?;
    Ok(latest.is_some_and(|latest| TERMINAL_ITEM_TYPES.contains(&latest.as_str())))
}

fn is_redundant(db: &Db, thread_id: &str, event: &Value) -> DbResult<bool> {
    let kind = event_type(event).unwrap_or_default();
    if kind == "turn/diff/updated" {
        return Ok(true);
    }
    if let Some(turn_id) = event_turn_id(event) {
        if kind == "turn/started" || kind == "turn/completed" {
            return has_turn_event(db, thread_id, turn_id, kind);
        }
        if ORPHAN_DROPPABLE_TYPES.contains(&kind)
            && !has_turn_event(db, thread_id, turn_id, "turn/started")?
        {
            return Ok(true);
        }
    }
    match event_item_id(event) {
        Some(item_id) if TERMINAL_ITEM_TYPES.contains(&kind) => {
            is_item_settled(db, thread_id, item_id)
        }
        _ => Ok(false),
    }
}

pub fn prune_superseded_deltas(db: &Db, thread_id: &str, item_id: &str) -> DbResult<()> {
    let sql = format!(
        "DELETE FROM events
     WHERE thread_id = ? AND item_id = ? AND type IN ({DELTA_TYPE_LIST})
       AND sequence > (
         SELECT MIN(first.sequence) FROM events first
         WHERE first.thread_id = events.thread_id
           AND first.item_id = events.item_id AND first.type = events.type
       )"
    );
    db.run(&sql, [thread_id, item_id])?;
    Ok(())
}

/// Writes one search segment, or deletes it when `text` is blank. `kind` is a
/// `ThreadSearchSourceKind` (`title`, `title_fallback`, `user_message`, ...).
pub fn upsert_search_segment(
    db: &Db,
    thread_id: &str,
    kind: &str,
    key: &str,
    sequence: Option<i64>,
    text: Option<&str>,
) -> DbResult<()> {
    let trimmed = text.map(str::trim).unwrap_or_default();
    if trimmed.is_empty() {
        db.run(
            "DELETE FROM thread_search_segments
       WHERE thread_id = ? AND source_kind = ? AND source_key = ?",
            [thread_id, kind, key],
        )?;
        return Ok(());
    }
    let segment = row! {
        "id" => format!("{thread_id}:{kind}:{key}"),
        "threadId" => thread_id,
        "sourceKind" => kind,
        "sourceKey" => key,
        "sourceSeq" => sequence,
        "text" => trimmed,
        "createdAt" => db.now(),
        "updatedAt" => db.now(),
    };
    let identity = ["thread_id", "source_kind", "source_key"];
    insert_row(db, "thread_search_segments", &segment, OnConflict::Update(&identity))
}

fn visible_prompt_input(input: &[Value]) -> Vec<Value> {
    let agent_only = |part: &&Value| part.get("visibility") == Some(&Value::from("agent-only"));
    input.iter().filter(|part| !agent_only(part)).cloned().collect()
}

fn visible_prompt_text(input: &[Value]) -> String {
    let texts: Vec<&str> = input
        .iter()
        .filter(|part| part.get("visibility") != Some(&Value::from("agent-only")))
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
        .map(|part| part.get("text").and_then(Value::as_str).unwrap_or_default())
        .collect();
    texts.join("\n").trim().to_owned()
}

fn record_turn_request(db: &Db, thread: &ThreadRow, event: &Value, sequence: i64) -> DbResult<()> {
    let key = format!("event:{sequence}");
    let parts: &[Value] = event.get("input").and_then(Value::as_array).map_or(&[], Vec::as_slice);
    let text = visible_prompt_text(parts);
    upsert_search_segment(db, &thread.id, "user_message", &key, Some(sequence), Some(&text))?;
    if event.get("initiator").and_then(Value::as_str) != Some("user") {
        return Ok(());
    }
    let now = db.now();
    db.run("UPDATE threads SET last_read_at = ? WHERE id = ?", params![now, thread.id])?;
    let target_kind = event.pointer("/target/kind").and_then(Value::as_str);
    let starts = target_kind == Some("thread-start");
    let input = visible_prompt_input(parts);
    if input.is_empty() || (starts && thread.parent_thread_id.is_some()) {
        return Ok(());
    }
    let entry = row! {
        "id" => new_id("phist"),
        "projectId" => thread.project_id.as_str(),
        "threadId" => thread.id.as_str(),
        "scope" => if starts { "project" } else { "thread" },
        "requestSequence" => sequence,
        "input" => serde_json::to_string(&input)?,
        "createdAt" => now,
    };
    insert_row(db, "prompt_history_entries", &entry, OnConflict::Fail)
}

fn insert_event(db: &Db, thread: &ThreadRow, event: &Value, sequence: i64) -> DbResult<()> {
    let kind = event_type(event).unwrap_or_default();
    let values = row! {
        "id" => new_id("evt"),
        "threadId" => thread.id.as_str(),
        "environmentId" => thread.environment_id.as_deref(),
        "scopeKind" => event_scope_kind(event).unwrap_or_default(),
        "turnId" => event_turn_id(event),
        "providerThreadId" => event_provider_thread_id(event),
        "sequence" => sequence,
        "type" => kind,
        "itemId" => event_item_id(event),
        "itemKind" => event_item_kind(event),
        "parentToolCallId" => event_parent_tool_call_id(event),
        "data" => serde_json::to_string(&event_data(event))?,
        "createdAt" => db.now(),
    };
    insert_row(db, "events", &values, OnConflict::Fail)?;
    if kind == "client/turn/requested" {
        record_turn_request(db, thread, event, sequence)?;
    } else if kind == "item/completed" {
        let item = event_item(event);
        let item_id = item.and_then(|item| item.get("id")).and_then(Value::as_str);
        prune_superseded_deltas(db, &thread.id, item_id.unwrap_or_default())?;
        if event_item_kind(event) != Some("agentMessage") {
            return Ok(());
        }
        let key = format!("event:{sequence}");
        let text = item.and_then(|item| item.get("text")).and_then(Value::as_str);
        upsert_search_segment(db, &thread.id, "assistant_message", &key, Some(sequence), text)?;
    }
    Ok(())
}

/// Stores events at the next sequences in one transaction and returns the ones kept
/// (runner events that repeat what is already stored are dropped).
pub fn append_events(
    db: &Db,
    thread: &ThreadRow,
    events: &[Value],
    source: EventSource,
) -> DbResult<Vec<Value>> {
    db.transaction(|| {
        let mut sequence = latest_sequence(db, &thread.id)?;
        let mut stored = Vec::new();
        for event in events {
            if source == EventSource::Runner && is_redundant(db, &thread.id, event)? {
                continue;
            }
            sequence += 1;
            insert_event(db, thread, event, sequence)?;
            stored.push(event.clone());
        }
        Ok(stored)
    })
}

pub fn last_system_error_message(db: &Db, thread_id: &str) -> DbResult<Option<String>> {
    let rows = db.rows(
        "SELECT json_extract(data, '$.message') AS message FROM events
     WHERE thread_id = ? AND type = 'system/error'
     ORDER BY sequence DESC LIMIT 1",
        [thread_id],
    )?;
    let message = rows.into_iter().next().and_then(|mut row| row.remove("message"));
    Ok(message.and_then(|message| message.as_str().map(str::to_owned)))
}

pub fn is_queue_auto_send_paused(db: &Db, thread_id: &str) -> DbResult<bool> {
    let rows = db.rows(
        "SELECT sequence, json_extract(data, '$.reason') AS reason FROM events
     WHERE thread_id = ? AND type = 'system/thread/interrupted'
     ORDER BY sequence DESC LIMIT 1",
        [thread_id],
    )?;
    let Some(stop) = rows.into_iter().next() else { return Ok(false) };
    if stop.get("reason").and_then(Value::as_str) != Some("manual-stop") {
        return Ok(false);
    }
    let stop_sequence = stop.get("sequence").and_then(Value::as_i64).unwrap_or_default();
    let later = db.rows(
        "SELECT 1 FROM events
     WHERE thread_id = ? AND type = 'client/turn/requested' AND sequence > ?",
        params![thread_id, stop_sequence],
    )?;
    Ok(later.is_empty())
}
