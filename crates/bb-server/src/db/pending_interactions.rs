use serde::de::Error as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Db, DbError, DbResult, OnConflict, insert_row, new_id};
use crate::domain::pending_interaction::{
    PendingInteraction, PendingInteractionOrigin, PendingInteractionOriginKind,
    PendingInteractionStatus,
};
use crate::row;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingInteractionRow {
    pub id: String,
    pub thread_id: String,
    pub origin_kind: PendingInteractionOriginKind,
    pub turn_id: Option<String>,
    pub provider_id: Option<String>,
    pub provider_thread_id: Option<String>,
    pub provider_request_id: Option<String>,
    pub plugin_id: Option<String>,
    pub renderer_id: Option<String>,
    pub status: PendingInteractionStatus,
    pub status_reason: Option<String>,
    pub payload: String,
    pub resolution: Option<String>,
    pub created_at: i64,
    pub expires_at: Option<i64>,
    pub resolved_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct NewPendingInteraction {
    pub thread_id: String,
    pub origin_kind: PendingInteractionOriginKind,
    pub turn_id: Option<String>,
    pub provider_id: Option<String>,
    pub provider_thread_id: Option<String>,
    pub provider_request_id: Option<String>,
    pub plugin_id: Option<String>,
    pub renderer_id: Option<String>,
    pub payload: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub struct InteractionSettlement {
    pub status: PendingInteractionStatus,
    pub status_reason: Option<String>,
    /// `None` keeps the stored resolution.
    pub resolution: Option<Value>,
}

const UNSCOPED_TURN_ID: &str = "none";

pub fn get_pending_interaction(db: &Db, id: &str) -> DbResult<Option<PendingInteractionRow>> {
    db.get("SELECT * FROM pending_interactions WHERE id = ?", [id])
}

pub fn find_provider_interaction(
    db: &Db,
    thread_id: &str,
    provider_request_id: &str,
) -> DbResult<Option<PendingInteractionRow>> {
    db.get(
        "SELECT * FROM pending_interactions
     WHERE thread_id = ? AND provider_request_id = ?",
        [thread_id, provider_request_id],
    )
}

pub fn list_active_interactions(db: &Db, thread_id: &str) -> DbResult<Vec<PendingInteractionRow>> {
    db.all(
        "SELECT * FROM pending_interactions
     WHERE thread_id = ? AND status IN ('pending', 'resolving') ORDER BY created_at",
        [thread_id],
    )
}

pub fn list_active_plugin_interactions(db: &Db) -> DbResult<Vec<PendingInteractionRow>> {
    db.all(
        "SELECT * FROM pending_interactions
     WHERE origin_kind = 'plugin' AND status IN ('pending', 'resolving')",
        [],
    )
}

pub fn has_turn_bound_interaction(db: &Db, thread_id: &str) -> DbResult<bool> {
    let rows = list_active_interactions(db, thread_id)?;
    Ok(rows.iter().any(|row| row.origin_kind == PendingInteractionOriginKind::Provider))
}

pub fn insert_pending_interaction(
    db: &Db,
    input: NewPendingInteraction,
) -> DbResult<PendingInteractionRow> {
    let id = new_id("pint");
    let mut values = row! {
        "threadId" => &input.thread_id,
        "originKind" => input.origin_kind.as_str(),
    };
    let optional = [
        ("turnId", input.turn_id),
        ("providerId", input.provider_id),
        ("providerThreadId", input.provider_thread_id),
        ("providerRequestId", input.provider_request_id),
        ("pluginId", input.plugin_id),
        ("rendererId", input.renderer_id),
    ];
    for (key, value) in optional {
        if let Some(value) = value {
            values.put(key, value);
        }
    }
    values.put("payload", serde_json::to_string(&input.payload)?);
    values.put("id", &id);
    values.put("status", PendingInteractionStatus::Pending.as_str());
    values.put("createdAt", db.now());
    values.put("updatedAt", db.now());
    insert_row(db, "pending_interactions", &values, OnConflict::Fail)?;
    match get_pending_interaction(db, &id)? {
        Some(row) => Ok(row),
        None => Err(DbError::Decode(serde_json::Error::custom("Interaction insert was lost"))),
    }
}

pub fn settle_interaction(
    db: &Db,
    id: &str,
    from: &[PendingInteractionStatus],
    next: InteractionSettlement,
) -> DbResult<Option<PendingInteractionRow>> {
    let Some(current) = get_pending_interaction(db, id)? else { return Ok(None) };
    if !from.contains(&current.status) {
        return Ok(None);
    }
    let now = db.now();
    let resolution = match &next.resolution {
        None => current.resolution,
        Some(value) => Some(serde_json::to_string(value)?),
    };
    let resolved_at = (next.status != PendingInteractionStatus::Resolving).then_some(now);
    db.run(
        "UPDATE pending_interactions
     SET status = ?, status_reason = ?, resolution = ?, resolved_at = ?,
         updated_at = ?
     WHERE id = ?",
        rusqlite::params![
            next.status.as_str(),
            next.status_reason,
            resolution,
            resolved_at,
            now,
            id
        ],
    )?;
    get_pending_interaction(db, id)
}

fn required(value: &Option<String>, field: &str) -> DbResult<String> {
    match value {
        Some(value) if !value.is_empty() => Ok(value.clone()),
        _ => Err(DbError::Decode(serde_json::Error::custom(format!(
            "pending interaction {field} is required"
        )))),
    }
}

pub fn to_pending_interaction(row: &PendingInteractionRow) -> DbResult<PendingInteraction> {
    let payload: Value = serde_json::from_str(&row.payload)?;
    let resolution: Option<Value> =
        row.resolution.as_deref().map(serde_json::from_str).transpose()?;
    let (turn_id, provider, origin) = match row.origin_kind {
        PendingInteractionOriginKind::Provider => {
            let provider_id = required(&row.provider_id, "providerId")?;
            let provider_thread_id = required(&row.provider_thread_id, "providerThreadId")?;
            let provider_request_id = required(&row.provider_request_id, "providerRequestId")?;
            let origin = PendingInteractionOrigin::Provider {
                provider_id: provider_id.clone(),
                provider_thread_id: provider_thread_id.clone(),
                provider_request_id: provider_request_id.clone(),
            };
            let turn_id = row.turn_id.clone().unwrap_or_else(|| UNSCOPED_TURN_ID.to_owned());
            let provider = (Some(provider_id), Some(provider_thread_id), Some(provider_request_id));
            (Some(turn_id), provider, origin)
        }
        PendingInteractionOriginKind::Plugin => {
            let origin = PendingInteractionOrigin::Plugin {
                plugin_id: required(&row.plugin_id, "pluginId")?,
                renderer_id: required(&row.renderer_id, "rendererId")?,
            };
            (row.turn_id.clone(), (None, None, None), origin)
        }
    };
    let (provider_id, provider_thread_id, provider_request_id) = provider;
    Ok(PendingInteraction {
        id: row.id.clone(),
        thread_id: row.thread_id.clone(),
        status: row.status,
        status_reason: row.status_reason.clone(),
        created_at: row.created_at,
        expires_at: row.expires_at,
        resolved_at: row.resolved_at,
        turn_id,
        provider_id,
        provider_thread_id,
        provider_request_id,
        origin,
        payload,
        resolution,
    })
}
