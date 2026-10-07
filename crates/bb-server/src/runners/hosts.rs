use std::sync::Arc;

use serde_json::json;

use crate::config::data_paths;
use crate::context::ServerContext;
use crate::db::environments::get_environment;
use crate::db::hosts::{self, HostLookup, HostRow, HostState, NewHost};
use crate::db::settings::get_app_settings;
use crate::domain::host::{Host, MachinePhase};
use crate::error::{ApiError, ApiResult};
use crate::runners::registry::Registration;

pub fn public_server_url(ctx: &ServerContext) -> ApiResult<Option<String>> {
    let machine_server_url = get_app_settings(&ctx.db)?.machine_server_url;
    let url = ctx.plugins.public_url().or(machine_server_url);
    Ok(url.map(|url| url.trim_end_matches('/').to_owned()))
}

pub fn require_host(ctx: &ServerContext, host_id: &str) -> ApiResult<HostRow> {
    hosts::find_host(&ctx.db, HostLookup::Id, host_id)?
        .ok_or_else(|| ApiError::new(404, "host_not_found", "Host not found"))
}

pub fn resolve_lookup_host_id(
    ctx: &ServerContext,
    host_id: Option<&str>,
    environment_id: Option<&str>,
) -> ApiResult<String> {
    let Some(environment_id) = environment_id else {
        return Ok(require_host(ctx, host_id.unwrap_or(&ctx.config.host_id))?.id);
    };
    let environment = get_environment(&ctx.db, environment_id)?
        .ok_or_else(|| ApiError::new(404, "environment_not_found", "Environment not found"))?;
    Ok(require_host(ctx, &environment.host_id)?.id)
}

pub fn host_response(ctx: &ServerContext, row: &HostRow) -> Host {
    let status = HostState {
        connected: ctx.runners.is_connected(&row.id),
        local: row.id == ctx.config.host_id,
    };
    hosts::to_host(row, status)
}

/// Node's `process.platform` for this build.
pub fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

pub(crate) fn host_name() -> String {
    let mut buffer = [0u8; 256];
    let result = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) };
    if result != 0 {
        return String::new();
    }
    let end = buffer.iter().position(|byte| *byte == 0).unwrap_or(buffer.len());
    String::from_utf8_lossy(&buffer[..end]).into_owned()
}

/// Registers the server's own machine and keeps `last_seen_at` (and the
/// `creating` → `active` transition) current as runners come and go. Dropping
/// the returned registrations stops the bookkeeping.
pub fn ensure_local_host(ctx: &ServerContext) -> ApiResult<Vec<Registration>> {
    let db = &ctx.db;
    let id = ctx.config.host_id.as_str();
    let thread_storage_root = data_paths(&ctx.config.data_dir).thread_storage;
    hosts::insert_host(
        db,
        &NewHost {
            id: id.to_owned(),
            name: host_name(),
            phase: MachinePhase::Active,
            status_message: None,
            launch_key: None,
        },
    )?;
    let patch = crate::row! {
        "platform" => node_platform(),
        "threadStorageRoot" => thread_storage_root.to_string_lossy().as_ref(),
        "lastSeenAt" => db.now(),
    };
    hosts::update_host(db, id, &patch)?;
    let connected_db = db.clone();
    let connected_log = ctx.log.clone();
    let off_connected = ctx.runners.on_connected(Arc::new(move |host_id: &str| {
        let db = &connected_db;
        let result = hosts::find_host(db, HostLookup::Id, host_id).and_then(|row| {
            let enrolling = row.is_some_and(|row| row.phase == MachinePhase::Creating);
            let mut patch = crate::row! { "lastSeenAt" => db.now() };
            if enrolling {
                patch.put("phase", MachinePhase::Active.as_str());
                patch.put("statusMessage", ());
            }
            hosts::update_host(db, host_id, &patch)
        });
        if let Err(error) = result {
            connected_log.error("Host update failed", json!({ "err": error.to_string() }));
        }
    }));
    let disconnected_db = db.clone();
    let disconnected_log = ctx.log.clone();
    let off_disconnected = ctx.runners.on_disconnected(Arc::new(move |host_id: &str| {
        let db = &disconnected_db;
        let patch = crate::row! { "lastSeenAt" => db.now() };
        if let Err(error) = hosts::update_host(db, host_id, &patch) {
            disconnected_log.error("Host update failed", json!({ "err": error.to_string() }));
        }
    }));
    Ok(vec![off_connected, off_disconnected])
}
