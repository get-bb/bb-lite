use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use indexmap::IndexMap;
use rand::RngExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::db::Db;
use crate::db::hosts::{HostLookup, HostRow, find_host, update_host};
use crate::domain::host::MachinePhase;
use crate::error::{ApiError, ApiResult, forbidden};
use crate::http::trust::Principal;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinToken {
    pub join_token: String,
    pub expires_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinBlob {
    pub server_url: String,
    pub host_id: String,
    pub join_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<IndexMap<String, String>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerCredential {
    pub host_id: String,
    pub runner_token: String,
}

pub struct JoinRequest<'a> {
    pub authorization: Option<&'a str>,
    pub principal: &'a Principal,
    pub host_name: Option<&'a str>,
}

pub const JOIN_TOKEN_TTL_MS: i64 = 15 * 60_000;
const TOKEN_BYTES: usize = 32;

fn mint_token(prefix: &str) -> String {
    let bytes: [u8; TOKEN_BYTES] = rand::rng().random();
    format!("{prefix}_{}", URL_SAFE_NO_PAD.encode(bytes))
}

pub fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn same_hash(stored: Option<&str>, presented: &str) -> bool {
    let Some(stored) = stored else { return false };
    if stored.len() != presented.len() {
        return false;
    }
    stored.bytes().zip(presented.bytes()).fold(0u8, |diff, (a, b)| diff | (a ^ b)) == 0
}

fn reject_credential(code: &str, message: &str) -> ApiError {
    ApiError::new(401, code, message)
}

/// The token of an `Authorization: Bearer <token>` header (`/^Bearer (\S+)$/`).
pub fn bearer_token(authorization: Option<&str>) -> Option<&str> {
    let token = authorization?.strip_prefix("Bearer ")?;
    let valid = !token.is_empty() && !token.chars().any(char::is_whitespace);
    valid.then_some(token)
}

pub fn issue_join_token(db: &Db, host_id: &str) -> ApiResult<JoinToken> {
    let join_token = mint_token("bbj");
    let expires_at = db.now() + JOIN_TOKEN_TTL_MS;
    let patch = crate::row! {
        "joinTokenHash" => hash_token(&join_token).as_str(),
        "joinExpiresAt" => expires_at,
    };
    update_host(db, host_id, &patch)?;
    Ok(JoinToken { join_token, expires_at })
}

pub fn join_command(blob: &JoinBlob) -> ApiResult<String> {
    let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(blob)?);
    Ok(format!("bb runner join {encoded}"))
}

pub fn redeem_join_token(db: &Db, request: JoinRequest<'_>) -> ApiResult<RunnerCredential> {
    let refusal = || {
        reject_credential(
            "invalid_join_token",
            "This join token is unknown, already used or expired. Create a new command from the \
             machines settings.",
        )
    };
    let token = bearer_token(request.authorization).ok_or_else(refusal)?;
    let presented = hash_token(token);
    db.transaction(|| {
        let host = find_host(db, HostLookup::JoinTokenHash, &presented)?
            .filter(|host| same_hash(host.join_token_hash.as_deref(), &presented))
            .ok_or_else(refusal)?;
        if host.join_expires_at.unwrap_or(0) <= db.now() {
            return Err(refusal());
        }
        let runner_token = mint_token("bbr");
        let mut patch = crate::row! {
            "joinTokenHash" => (),
            "joinExpiresAt" => (),
            "tokenHash" => hash_token(&runner_token).as_str(),
        };
        if host.phase == MachinePhase::Creating
            && let Some(name) = request.host_name
        {
            patch.put("name", name);
        }
        if let Principal::Runner { connect_machine_id } = request.principal {
            patch.put("connectMachineId", connect_machine_id.as_deref());
        }
        update_host(db, &host.id, &patch)?;
        Ok(RunnerCredential { host_id: host.id, runner_token })
    })
}

pub fn find_runner_host(db: &Db, token: &str) -> ApiResult<Option<HostRow>> {
    let presented = hash_token(token);
    let host = find_host(db, HostLookup::TokenHash, &presented)?;
    Ok(host.filter(|host| same_hash(host.token_hash.as_deref(), &presented)))
}

pub fn authenticate_runner(
    db: &Db,
    authorization: Option<&str>,
    principal: &Principal,
) -> ApiResult<HostRow> {
    let host = match bearer_token(authorization) {
        Some(token) => find_runner_host(db, token)?,
        None => None,
    };
    let host = host.ok_or_else(|| {
        reject_credential(
            "invalid_runner_token",
            "This runner token is not valid for any machine on this server.",
        )
    })?;
    if let Principal::Runner { connect_machine_id } = principal
        && *connect_machine_id != host.connect_machine_id
    {
        let owner = "a different bb connect machine";
        return Err(forbidden(format!("This runner token belongs to {owner}.")));
    }
    Ok(host)
}
