use serde::de::Error as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::order_keys::order_key_between;
use super::{Db, DbError, DbResult, OnConflict, insert_row, new_id};
use crate::domain::queued_message::{
    QueuedMessageInitiator, QueuedMessagePayload, QueuedMessageSystemNotice,
    QueuedMessageWaitingOn, QueuedMessageWaitingOnKind, ThreadCreateOrigin, ThreadQueuedMessage,
};
use crate::error::ApiError;
use crate::row;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedMessageRow {
    pub id: String,
    pub thread_id: String,
    pub origin: Option<ThreadCreateOrigin>,
    pub origin_plugin_id: Option<String>,
    pub sender_thread_id: Option<String>,
    pub model: String,
    pub reasoning_level: String,
    pub permission_mode: String,
    pub service_tier: String,
    pub send_at: Option<i64>,
    pub failure_reason: Option<String>,
    pub content: String,
    pub system_notice: Option<String>,
    pub waiting_on: Option<String>,
    pub sort_key: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct NewQueuedMessage {
    pub thread_id: String,
    pub sender_thread_id: Option<String>,
    pub send_at: Option<i64>,
    pub content: Vec<Value>,
    pub model: String,
    pub reasoning_level: String,
    pub permission_mode: String,
    pub service_tier: String,
    pub waiting_on: Option<QueuedMessageWaitingOn>,
    pub system_notice: Option<QueuedMessageSystemNotice>,
}

pub fn queued_message_not_found() -> ApiError {
    ApiError::new(404, "invalid_request", "Queued message not found")
}

pub fn list_queued_messages(db: &Db, thread_id: &str) -> DbResult<Vec<QueuedMessageRow>> {
    db.all(
        "SELECT * FROM queued_thread_messages
     WHERE thread_id = ? ORDER BY sort_key, id",
        [thread_id],
    )
}

pub fn get_queued_message(
    db: &Db,
    thread_id: &str,
    id: &str,
) -> DbResult<Option<QueuedMessageRow>> {
    db.get("SELECT * FROM queued_thread_messages WHERE thread_id = ? AND id = ?", [thread_id, id])
}

fn encode_optional<T: Serialize>(value: Option<&T>) -> DbResult<Option<String>> {
    Ok(value.map(serde_json::to_string).transpose()?)
}

pub fn insert_queued_message(db: &Db, input: NewQueuedMessage) -> DbResult<QueuedMessageRow> {
    let id = new_id("qmsg");
    let last = list_queued_messages(db, &input.thread_id)?.pop();
    let sort_key = order_key_between(last.as_ref().map(|row| row.sort_key.as_str()), None)
        .map_err(|error| DbError::Decode(serde_json::Error::custom(error)))?;
    let values = row! {
        "threadId" => &input.thread_id,
        "senderThreadId" => input.sender_thread_id.clone(),
        "sendAt" => input.send_at,
        "content" => serde_json::to_string(&input.content)?,
        "model" => &input.model,
        "reasoningLevel" => &input.reasoning_level,
        "permissionMode" => &input.permission_mode,
        "serviceTier" => &input.service_tier,
        "waitingOn" => encode_optional(input.waiting_on.as_ref())?,
        "systemNotice" => encode_optional(input.system_notice.as_ref())?,
        "id" => &id,
        "sortKey" => sort_key,
        "createdAt" => db.now(),
        "updatedAt" => db.now(),
    };
    insert_row(db, "queued_thread_messages", &values, OnConflict::Fail)?;
    match get_queued_message(db, &input.thread_id, &id)? {
        Some(row) => Ok(row),
        None => Err(DbError::Decode(serde_json::Error::custom("Queued message insert was lost"))),
    }
}

pub fn delete_queued_messages(db: &Db, ids: &[String]) -> DbResult<()> {
    for id in ids {
        db.run("DELETE FROM queued_thread_messages WHERE id = ?", [id])?;
    }
    Ok(())
}

pub fn set_queued_message_wait(
    db: &Db,
    rows: &[QueuedMessageRow],
    waiting_on: Option<&QueuedMessageWaitingOn>,
) -> DbResult<()> {
    let encoded = encode_optional(waiting_on)?;
    for row in rows {
        db.run(
            "UPDATE queued_thread_messages SET waiting_on = ?, updated_at = ?
       WHERE id = ?",
            rusqlite::params![encoded, db.now().max(row.updated_at + 1), row.id],
        )?;
    }
    Ok(())
}

pub fn update_queued_message_content(
    db: &Db,
    row: &QueuedMessageRow,
    content: &[Value],
) -> DbResult<()> {
    db.run(
        "UPDATE queued_thread_messages SET content = ?, updated_at = ? WHERE id = ?",
        rusqlite::params![
            serde_json::to_string(content)?,
            db.now().max(row.updated_at + 1),
            row.id
        ],
    )?;
    Ok(())
}

pub fn parse_queued_content(row: &QueuedMessageRow) -> DbResult<Vec<Value>> {
    let content: Vec<Value> = serde_json::from_str(&row.content)?;
    if content.is_empty() {
        return Err(DbError::Decode(serde_json::Error::custom(
            "Array must contain at least 1 element(s)",
        )));
    }
    Ok(content)
}

pub fn parse_queued_wait(row: &QueuedMessageRow) -> DbResult<Option<QueuedMessageWaitingOn>> {
    let Some(text) = &row.waiting_on else { return Ok(None) };
    let wait: QueuedMessageWaitingOn = serde_json::from_str(text)?;
    wait.validate().map_err(|message| DbError::Decode(serde_json::Error::custom(message)))?;
    Ok(Some(wait))
}

pub fn parse_queued_notice(row: &QueuedMessageRow) -> DbResult<Option<QueuedMessageSystemNotice>> {
    let Some(text) = &row.system_notice else { return Ok(None) };
    Ok(Some(serde_json::from_str(text)?))
}

pub fn list_thread_ids_waiting_on(
    db: &Db,
    kind: QueuedMessageWaitingOnKind,
    due_by: Option<i64>,
) -> DbResult<Vec<String>> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ThreadIdRow {
        thread_id: String,
    }
    let rows: Vec<ThreadIdRow> = db.all(
        "SELECT DISTINCT thread_id FROM queued_thread_messages
     WHERE json_extract(waiting_on, '$.kind') = ?
       AND (? IS NULL OR send_at <= ?)",
        rusqlite::params![kind.as_str(), due_by, due_by],
    )?;
    Ok(rows.into_iter().map(|row| row.thread_id).collect())
}

pub fn queued_initiator(row: &QueuedMessageRow) -> QueuedMessageInitiator {
    if row.system_notice.is_some() {
        return QueuedMessageInitiator::System;
    }
    match row.sender_thread_id {
        None => QueuedMessageInitiator::User,
        Some(_) => QueuedMessageInitiator::Agent,
    }
}

pub fn to_thread_queued_message(row: &QueuedMessageRow) -> DbResult<ThreadQueuedMessage> {
    Ok(ThreadQueuedMessage {
        id: row.id.clone(),
        origin: row.origin,
        origin_plugin_id: row.origin_plugin_id.clone(),
        initiator: queued_initiator(row),
        sender_thread_id: row.sender_thread_id.clone(),
        thread_id: row.thread_id.clone(),
        content: parse_queued_content(row)?,
        model: row.model.clone(),
        reasoning_level: row.reasoning_level.clone(),
        permission_mode: row.permission_mode.clone(),
        service_tier: row.service_tier.clone(),
        group_with_next: false,
        send_at: row.send_at,
        waiting_on: parse_queued_wait(row)?,
        failure_reason: row.failure_reason.clone(),
        payload: QueuedMessagePayload::Inline,
        editable: true,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}
