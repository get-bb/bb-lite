use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use crate::context::{Ctx, ServerContext};
use crate::db::Db;
use crate::error::{ApiError, ApiResult, invalid_request};

/// The key file in the data directory: 32 random bytes as 64 lowercase hex digits and a newline.
pub const KEY_FILE: &str = "machine-environment-key";
pub const ENCRYPTION_VERSION: i64 = 2;
const IV_BYTES: usize = 12;
const TAG_BYTES: usize = 16;
const GIT_TOKEN_NAME: &str = "GH_TOKEN";
const NAME_MAX_LENGTH: usize = 128;
const VALUE_MAX_LENGTH: usize = 65_536;
const NOTE_MAX_LENGTH: usize = 1_024;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredVariable {
    project_id: Option<String>,
    name: String,
    ciphertext: String,
    note: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineEnvironmentVariable {
    pub name: String,
    pub value: Option<String>,
    pub secret: bool,
    pub note: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltInGitStatus {
    pub status: String,
    pub status_message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineEnvironmentList {
    pub variables: Vec<MachineEnvironmentVariable>,
    pub built_in_git: BuiltInGitStatus,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMachineEnvironmentList {
    pub built_in_git: BuiltInGitStatus,
    pub variables: Vec<MachineEnvironmentVariable>,
    pub inherited_variables: Vec<MachineEnvironmentVariable>,
}

/// One entry of `MachineEnvironmentReplace`: a `null` value keeps the saved one.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MachineEnvironmentReplacement {
    pub name: String,
    #[serde(deserialize_with = "Option::deserialize")]
    pub value: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MachineEnvironmentReplace {
    pub variables: Vec<MachineEnvironmentReplacement>,
}

/// `machineEnvironmentNameSchema`.
pub fn is_valid_machine_environment_name(name: &str) -> bool {
    let mut chars = name.chars();
    let first_ok = chars.next().is_some_and(|first| first.is_ascii_uppercase() || first == '_');
    first_ok
        && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        && name.len() <= NAME_MAX_LENGTH
}

impl MachineEnvironmentReplace {
    /// `machineEnvironmentReplaceSchema`'s refinements; the error is the request's message.
    pub fn validate(&self) -> Result<(), String> {
        let mut names = HashSet::new();
        for (index, variable) in self.variables.iter().enumerate() {
            let at = format!("variables.{index}");
            if !is_valid_machine_environment_name(&variable.name) {
                return Err(format!("{at}.name: Invalid environment variable name"));
            }
            if let Some(value) = &variable.value {
                if value.encode_utf16().count() > VALUE_MAX_LENGTH {
                    return Err(format!(
                        "{at}.value: String must contain at most {VALUE_MAX_LENGTH} character(s)"
                    ));
                }
                if value.contains('\0') {
                    return Err(format!("{at}.value: Environment values cannot contain NUL"));
                }
            }
            if variable
                .note
                .as_ref()
                .is_some_and(|note| note.encode_utf16().count() > NOTE_MAX_LENGTH)
            {
                return Err(format!(
                    "{at}.note: String must contain at most {NOTE_MAX_LENGTH} character(s)"
                ));
            }
            if !names.insert(variable.name.as_str()) {
                return Err(format!(
                    "{at}.name: Machine environment variable names must be unique"
                ));
            }
        }
        Ok(())
    }
}

async fn encryption_key(data_dir: &Path) -> ApiResult<[u8; 32]> {
    let path = data_dir.join(KEY_FILE);
    let Ok(stored) = tokio::fs::read_to_string(&path).await else {
        let created: [u8; 32] = rand::random();
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&path).await?;
        file.write_all(format!("{}\n", hex::encode(created)).as_bytes()).await?;
        file.flush().await?;
        return Ok(created);
    };
    let trimmed = stored.trim();
    let valid =
        trimmed.len() == 64 && trimmed.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    let mut key = [0u8; 32];
    if !valid || hex::decode_to_slice(trimmed, &mut key).is_err() {
        let message = format!("{} is not a machine environment key; restore it.", path.display());
        return Err(ApiError::internal(message));
    }
    Ok(key)
}

fn associated_data(project_id: Option<&str>, name: &str) -> Vec<u8> {
    serde_json::to_vec(&(project_id, name)).unwrap_or_default()
}

/// AES-256-GCM with a random 12-byte IV and the JSON `[projectId, name]` as associated data,
/// stored as base64 of IV, tag and ciphertext, exactly as the TypeScript server does.
pub fn encrypt(key: &[u8; 32], project_id: Option<&str>, name: &str, value: &str) -> String {
    let iv: [u8; IV_BYTES] = rand::random();
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let aad = associated_data(project_id, name);
    let payload = Payload { msg: value.as_bytes(), aad: &aad };
    let Ok(sealed) = cipher.encrypt(Nonce::from_slice(&iv), payload) else {
        return String::new();
    };
    let (body, tag) = sealed.split_at(sealed.len() - TAG_BYTES);
    let mut out = Vec::with_capacity(sealed.len() + IV_BYTES);
    out.extend_from_slice(&iv);
    out.extend_from_slice(tag);
    out.extend_from_slice(body);
    STANDARD.encode(out)
}

/// The inverse of [`encrypt`], or the TypeScript error message when it cannot be decrypted.
pub fn decrypt(
    key: &[u8; 32],
    project_id: Option<&str>,
    name: &str,
    ciphertext: &str,
) -> Result<String, String> {
    let opened = STANDARD
        .decode(ciphertext)
        .ok()
        .filter(|sealed| sealed.len() >= IV_BYTES + TAG_BYTES)
        .and_then(|sealed| {
            let (iv, rest) = sealed.split_at(IV_BYTES);
            let (tag, body) = rest.split_at(TAG_BYTES);
            let mut joined = body.to_vec();
            joined.extend_from_slice(tag);
            let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
            let aad = associated_data(project_id, name);
            let payload = Payload { msg: &joined, aad: &aad };
            cipher.decrypt(Nonce::from_slice(iv), payload).ok()
        });
    opened.and_then(|plain| String::from_utf8(plain).ok()).ok_or_else(|| {
        format!(
            "Machine environment variable {name} cannot be decrypted; \
             restore its encryption key or set it again."
        )
    })
}

fn list_variables(db: &Db, project_id: Option<&str>) -> ApiResult<Vec<StoredVariable>> {
    let sql = "SELECT project_id, name, ciphertext, note FROM environment_variables
     WHERE project_id IS ? ORDER BY name";
    Ok(db.all(sql, [project_id])?)
}

fn public_variables(variables: Vec<StoredVariable>) -> Vec<MachineEnvironmentVariable> {
    variables
        .into_iter()
        .map(|StoredVariable { name, note, .. }| MachineEnvironmentVariable {
            name,
            value: None,
            secret: true,
            note,
        })
        .collect()
}

fn git_status(status: &str, message: &str) -> BuiltInGitStatus {
    BuiltInGitStatus { status: status.to_owned(), status_message: message.to_owned() }
}

pub fn machine_environment_view(db: &Db) -> ApiResult<MachineEnvironmentList> {
    let variables = public_variables(list_variables(db, None)?);
    let overridden = variables.iter().any(|variable| variable.name == GIT_TOKEN_NAME);
    let built_in_git = if overridden {
        git_status("overridden", "The built-in gh token is overridden by Machine environment.")
    } else {
        git_status("disabled", "Automatic GitHub credentials are disabled.")
    };
    Ok(MachineEnvironmentList { variables, built_in_git })
}

pub fn project_machine_environment_view(
    db: &Db,
    project_id: &str,
) -> ApiResult<ProjectMachineEnvironmentList> {
    let inherited = machine_environment_view(db)?;
    let variables = public_variables(list_variables(db, Some(project_id))?);
    let overridden = variables.iter().any(|variable| variable.name == GIT_TOKEN_NAME);
    let built_in_git = if overridden {
        git_status("overridden", "Overridden by this project.")
    } else {
        inherited.built_in_git
    };
    Ok(ProjectMachineEnvironmentList {
        built_in_git,
        variables,
        inherited_variables: inherited.variables,
    })
}

/// Replaces every variable of the scope (`None` is machine-wide); a `null` value keeps the
/// saved ciphertext and is refused when there is none.
pub async fn replace_machine_environment(
    ctx: &ServerContext,
    project_id: Option<&str>,
    input: &MachineEnvironmentReplace,
) -> ApiResult<()> {
    input.validate().map_err(invalid_request)?;
    let db = &ctx.db;
    let key = encryption_key(&ctx.config.data_dir).await?;
    db.transaction(|| {
        let saved: HashMap<String, String> = list_variables(db, project_id)?
            .into_iter()
            .map(|row| (row.name, row.ciphertext))
            .collect();
        db.run("DELETE FROM environment_variables WHERE project_id IS ?", [project_id])?;
        for variable in &input.variables {
            let name = variable.name.as_str();
            let ciphertext = match &variable.value {
                Some(value) => encrypt(&key, project_id, name, value),
                None => saved.get(name).cloned().ok_or_else(|| {
                    let message = format!("No saved value for {name}; reload settings and retry");
                    ApiError::new(409, "invalid_request", message)
                })?,
            };
            db.run(
                "INSERT INTO environment_variables
           (project_id, name, ciphertext, encryption_version, note, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)",
                rusqlite::params![
                    project_id,
                    name,
                    ciphertext,
                    ENCRYPTION_VERSION,
                    variable.note,
                    db.now()
                ],
            )?;
        }
        Ok(())
    })
}

/// The machine-wide and project environment variables, decrypted.
pub async fn resolve_contributed_environment(
    ctx: &Ctx,
    project_id: Option<&str>,
) -> ApiResult<BTreeMap<String, String>> {
    let mut variables = list_variables(&ctx.db, None)?;
    if let Some(project_id) = project_id {
        variables.extend(list_variables(&ctx.db, Some(project_id))?);
    }
    if variables.is_empty() {
        return Ok(BTreeMap::new());
    }
    let key = encryption_key(&ctx.config.data_dir).await?;
    variables
        .into_iter()
        .map(|variable| {
            let project_id = variable.project_id.as_deref();
            let value = decrypt(&key, project_id, &variable.name, &variable.ciphertext)
                .map_err(ApiError::internal)?;
            Ok((variable.name, value))
        })
        .collect()
}
