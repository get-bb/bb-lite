use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::config::data_paths;
use crate::context::ServerContext;
use crate::db::{Db, DbResult, new_id, params};
use crate::error::{ApiResult, invalid_request, not_found_message};

pub const PROMPT_ATTACHMENT_MAX_BYTES: u64 = 35 * 1024 * 1024;
const MEBIBYTE: f64 = 1024.0 * 1024.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum UploadedAttachmentType {
    #[serde(rename = "localImage")]
    LocalImage,
    #[serde(rename = "localFile")]
    LocalFile,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadedPromptAttachment {
    #[serde(rename = "type")]
    pub kind: UploadedAttachmentType,
    pub path: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    pub size_bytes: u64,
}

/// An uploaded file: its client-side name, its declared content type (empty when none) and
/// its bytes.
#[derive(Clone, Debug, Default)]
pub struct AttachmentUpload {
    pub name: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

struct AttachmentRecord<'a> {
    project_id: &'a str,
    stored_path: &'a str,
    original_name: &'a str,
    mime_type: Option<&'a str>,
    size_bytes: u64,
}

pub fn path_looks_runtime_readable(path: &str) -> bool {
    let mut chars = path.chars();
    match chars.next() {
        Some('/' | '\\') => return true,
        Some(first) if first.is_ascii_alphabetic() => {}
        _ => return false,
    }
    for c in chars {
        if c == ':' {
            return true;
        }
        if !(c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')) {
            return false;
        }
    }
    false
}

/// `canonicalProjectAttachmentPath`: the error is the user-visible message.
pub fn canonical_project_attachment_path(path: &str) -> Result<String, String> {
    let escapes = || "Attachment path escapes project directory".to_owned();
    if path_looks_runtime_readable(path) || path.contains('\0') {
        return Err(escapes());
    }
    let normalized = path.replace('\\', "/");
    let mut parts: Vec<&str> = Vec::new();
    for part in normalized.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err(escapes());
                }
            }
            part => parts.push(part),
        }
    }
    if parts.is_empty() {
        return Err("Attachment path must refer to a file inside the project directory".into());
    }
    if parts[0] == ".pending" {
        return Err("Attachment path is reserved for uploads".into());
    }
    Ok(parts.join("/"))
}

pub fn project_attachments_dir(data_dir: &Path, project_id: &str) -> PathBuf {
    data_paths(data_dir).attachments.join(project_id)
}

pub fn resolve_attachment_path(
    data_dir: &Path,
    project_id: &str,
    stored_name: &str,
) -> ApiResult<PathBuf> {
    let relative = canonical_project_attachment_path(stored_name).map_err(invalid_request)?;
    Ok(project_attachments_dir(data_dir, project_id).join(relative))
}

pub fn attachment_mime_type(path: &Path) -> Option<String> {
    mime_guess::from_path(path).first().map(|mime| mime.essence_str().to_owned())
}

fn base_name(name: &str) -> &str {
    let trimmed = name.trim_end_matches('/');
    trimmed.rsplit('/').next().unwrap_or(trimmed)
}

fn sanitize(name: &str) -> String {
    let mut out = String::new();
    let mut in_run = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('-');
            in_run = true;
        }
    }
    out
}

fn split_extension(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(index) if index > 0 && !name[..index].chars().all(|c| c == '.') => {
            name.split_at(index)
        }
        _ => (name, ""),
    }
}

fn stored_name_for(original_name: &str, now: i64) -> String {
    let sanitized = sanitize(base_name(original_name));
    let (stem, extension) = split_extension(&sanitized);
    let suffix = hex::encode(rand::random::<[u8; 3]>());
    let stem = if stem.is_empty() { "attachment" } else { stem };
    format!("{stem}-{now}-{suffix}{extension}")
}

fn megabytes(bytes: u64) -> String {
    let rounded = ((bytes as f64 / MEBIBYTE) * 10.0).round() / 10.0;
    if rounded.fract() == 0.0 { format!("{}", rounded as i64) } else { format!("{rounded}") }
}

fn is_heif(mime_type: &str) -> bool {
    let Some(rest) = mime_type.strip_prefix("image/hei") else {
        return false;
    };
    matches!(rest, "c" | "f" | "c-sequence" | "f-sequence")
}

fn record_attachment(db: &Db, record: &AttachmentRecord<'_>) -> DbResult<()> {
    db.run(
        "INSERT INTO project_attachments
           (id, project_id, stored_path, original_name, mime_type, size_bytes,
            created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
        params![
            new_id("att"),
            record.project_id,
            record.stored_path,
            record.original_name,
            record.mime_type,
            record.size_bytes as i64,
            db.now(),
        ],
    )?;
    Ok(())
}

pub async fn store_attachment(
    ctx: &ServerContext,
    project_id: &str,
    file: AttachmentUpload,
) -> ApiResult<UploadedPromptAttachment> {
    let mime_type = file.content_type.split(';').next().unwrap_or_default().trim().to_lowercase();
    if is_heif(&mime_type) {
        return Err(invalid_request(
            "HEIC images are not supported. Convert the image to JPEG or PNG before attaching it.",
        ));
    }
    let size = file.bytes.len() as u64;
    if size > PROMPT_ATTACHMENT_MAX_BYTES {
        let limit = megabytes(PROMPT_ATTACHMENT_MAX_BYTES);
        return Err(invalid_request(format!(
            "{} is {}MB, over the {limit}MB attachment limit",
            file.name,
            megabytes(size)
        )));
    }
    let stored_path = stored_name_for(&file.name, ctx.now());
    let target = resolve_attachment_path(&ctx.config.data_dir, project_id, &stored_path)?;
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mut options = tokio::fs::OpenOptions::new();
    let mut handle = options.write(true).create_new(true).open(&target).await?;
    tokio::io::AsyncWriteExt::write_all(&mut handle, &file.bytes).await?;
    tokio::io::AsyncWriteExt::flush(&mut handle).await?;
    let declared = (!file.content_type.is_empty()).then_some(file.content_type.as_str());
    record_attachment(
        &ctx.db,
        &AttachmentRecord {
            project_id,
            stored_path: &stored_path,
            original_name: &file.name,
            mime_type: declared,
            size_bytes: size,
        },
    )?;
    let kind = if mime_type.starts_with("image/") {
        UploadedAttachmentType::LocalImage
    } else {
        UploadedAttachmentType::LocalFile
    };
    Ok(UploadedPromptAttachment {
        kind,
        path: stored_path,
        name: file.name,
        mime_type: declared.map(str::to_owned),
        size_bytes: size,
    })
}

pub async fn copy_attachments(
    ctx: &ServerContext,
    from: &str,
    to: &str,
    paths: &[String],
) -> ApiResult<()> {
    if from == to {
        return Ok(());
    }
    let data_dir = &ctx.config.data_dir;
    let mut seen = HashSet::new();
    for stored_path in paths {
        if !seen.insert(stored_path.as_str()) {
            continue;
        }
        let source = resolve_attachment_path(data_dir, from, stored_path)?;
        let target = resolve_attachment_path(data_dir, to, stored_path)?;
        let file = match tokio::fs::metadata(&source).await {
            Ok(file) if file.is_file() => file,
            _ => return Err(not_found_message("Attachment not found")),
        };
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::copy(&source, &target).await?;
        let canonical = canonical_project_attachment_path(stored_path).map_err(invalid_request)?;
        let mime_type = attachment_mime_type(Path::new(stored_path));
        record_attachment(
            &ctx.db,
            &AttachmentRecord {
                project_id: to,
                stored_path: &canonical,
                original_name: base_name(stored_path),
                mime_type: mime_type.as_deref(),
                size_bytes: file.len(),
            },
        )?;
    }
    Ok(())
}
