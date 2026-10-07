use serde::{Deserialize, Serialize};

use super::{Db, DbResult, OnConflict, RowValues, insert_row, params, update_row};
use crate::domain::host::{
    Host, HostStatus, HostType, MachineLifecycle, MachinePhase, PermissionMode,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRow {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub host_type: HostType,
    pub phase: MachinePhase,
    pub status_message: Option<String>,
    pub max_permission_mode: PermissionMode,
    pub launch_key: Option<String>,
    pub token_hash: Option<String>,
    pub join_token_hash: Option<String>,
    pub join_expires_at: Option<i64>,
    pub connect_machine_id: Option<String>,
    pub last_instance_id: Option<String>,
    pub last_event_seq: i64,
    pub last_seen_at: Option<i64>,
    pub last_rejected_protocol_version: Option<i64>,
    pub platform: Option<String>,
    pub thread_storage_root: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostLookup {
    Id,
    LaunchKey,
    TokenHash,
    JoinTokenHash,
}

impl HostLookup {
    pub fn column(self) -> &'static str {
        match self {
            Self::Id => "id",
            Self::LaunchKey => "launch_key",
            Self::TokenHash => "token_hash",
            Self::JoinTokenHash => "join_token_hash",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewHost {
    pub id: String,
    pub name: String,
    pub phase: MachinePhase,
    pub status_message: Option<String>,
    pub launch_key: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HostFilter {
    pub include_creating: bool,
    pub host_type: Option<HostType>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HostState {
    pub connected: bool,
    pub local: bool,
}

pub fn find_host(db: &Db, column: HostLookup, value: &str) -> DbResult<Option<HostRow>> {
    let column = column.column();
    let sql = format!("SELECT * FROM hosts WHERE {column} = ? AND destroyed_at IS NULL");
    db.get(&sql, [value])
}

pub fn find_host_name(db: &Db, id: &str) -> DbResult<Option<String>> {
    let sql = "SELECT name FROM hosts WHERE id = ?";
    db.scalar(sql, [id])
}

pub fn list_hosts(db: &Db, filter: HostFilter) -> DbResult<Vec<HostRow>> {
    let hosts: Vec<HostRow> = db.all(
        "SELECT * FROM hosts WHERE destroyed_at IS NULL
       ORDER BY created_at, id",
        [],
    )?;
    Ok(hosts
        .into_iter()
        .filter(|host| filter.include_creating || host.phase != MachinePhase::Creating)
        .filter(|host| filter.host_type.is_none_or(|host_type| host.host_type == host_type))
        .collect())
}

pub fn insert_host(db: &Db, host: &NewHost) -> DbResult<()> {
    let values = crate::row! {
        "id" => &host.id,
        "name" => &host.name,
        "phase" => host.phase.as_str(),
    }
    .set_some("statusMessage", host.status_message.as_deref())
    .set_some("launchKey", host.launch_key.as_deref())
    .set("createdAt", db.now())
    .set("updatedAt", db.now());
    insert_row(db, "hosts", &values, OnConflict::Ignore)
}

pub fn update_host(db: &Db, id: &str, patch: &RowValues) -> DbResult<()> {
    update_row(db, "hosts", id, patch, true)?;
    Ok(())
}

pub fn advance_host_event_cursor(db: &Db, id: &str, instance_id: &str, seq: i64) -> DbResult<()> {
    db.run(
        "UPDATE hosts SET last_event_seq = MAX(last_event_seq, ?)
     WHERE id = ? AND last_instance_id = ?",
        params![seq, id, instance_id],
    )?;
    Ok(())
}

pub fn destroy_host(db: &Db, id: &str) -> DbResult<()> {
    let patch = crate::row! {
        "phase" => "destroyed",
        "destroyedAt" => db.now(),
        "tokenHash" => (),
        "joinTokenHash" => (),
        "joinExpiresAt" => (),
        "launchKey" => (),
    };
    update_row(db, "hosts", id, &patch, true)?;
    Ok(())
}

pub fn to_host(row: &HostRow, status: HostState) -> Host {
    Host {
        id: row.id.clone(),
        name: row.name.clone(),
        host_type: row.host_type,
        status: if status.connected { HostStatus::Connected } else { HostStatus::Disconnected },
        machine_provider_id: if status.local { None } else { Some("manual".to_owned()) },
        lifecycle: MachineLifecycle {
            phase: row.phase,
            suspended_at: None,
            message: row.status_message.clone(),
            pending_log: String::new(),
            teardown: None,
        },
        max_permission_mode: row.max_permission_mode,
        last_seen_at: row.last_seen_at,
        last_rejected_protocol_version: row.last_rejected_protocol_version,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}
