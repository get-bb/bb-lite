use std::path::Path;

use base64::Engine;
use bb_core::api::call_typed;
use bb_core::{RunnerInfo, SharedRunner};
use serde_json::{Value, json};

use crate::context::Ctx;
use crate::db::threads::ThreadRow;
use crate::error::ApiResult;
use crate::projects::attachments::resolve_attachment_path;

pub struct AttachmentTarget<'a> {
    pub host_id: &'a str,
    pub runner: &'a SharedRunner,
    pub thread: &'a ThreadRow,
}

const CHUNK_BYTES: usize = 4 * 1024 * 1024;

/// `pathLooksRuntimeReadable` from `@bb/domain`; deduplicate once the domain port has it.
fn path_looks_runtime_readable(path: &str) -> bool {
    let mut chars = path.chars();
    match chars.next() {
        Some('/' | '\\') => true,
        Some(first) if first.is_ascii_alphabetic() => {
            for next in chars {
                if next == ':' {
                    return true;
                }
                if !(next.is_ascii_alphanumeric() || matches!(next, '+' | '.' | '-')) {
                    return false;
                }
            }
            false
        }
        _ => false,
    }
}

fn stored_path(part: &Value) -> Option<&str> {
    let kind = part.get("type").and_then(Value::as_str)?;
    if kind != "localImage" && kind != "localFile" {
        return None;
    }
    part.get("path").and_then(Value::as_str).filter(|path| !path_looks_runtime_readable(path))
}

fn with_path(part: &Value, path: &str) -> Value {
    let mut part = part.clone();
    if let Some(object) = part.as_object_mut() {
        object.insert("path".to_string(), Value::String(path.to_string()));
    }
    part
}

async fn copy_to_host(runner: &SharedRunner, source: &Path, path: &str) -> ApiResult<()> {
    let bytes = tokio::fs::read(source).await?;
    let mut offset = 0;
    loop {
        let chunk = &bytes[offset..bytes.len().min(offset + CHUNK_BYTES)];
        let data_base64 = base64::engine::general_purpose::STANDARD.encode(chunk);
        let write = json!({
            "path": path, "offset": offset, "dataBase64": data_base64, "createParents": true,
        });
        call_typed::<_, Value>(&**runner, "writeFileChunk", &write).await?;
        offset += CHUNK_BYTES;
        if offset >= bytes.len() {
            return Ok(());
        }
    }
}

/// Replaces stored project attachment paths in `input` (`PromptInput[]`) with
/// paths the target host can read, copying the files to remote hosts.
pub async fn deliver_attachments(
    ctx: &Ctx,
    target: AttachmentTarget<'_>,
    input: Vec<Value>,
) -> ApiResult<Vec<Value>> {
    if !input.iter().any(|part| stored_path(part).is_some()) {
        return Ok(input);
    }
    let AttachmentTarget { host_id, runner, thread } = target;
    let root = if host_id == ctx.config.host_id {
        None
    } else {
        let info: RunnerInfo = call_typed(&**runner, "describe", &Value::Null).await?;
        Some(info.thread_storage_root)
    };
    let mut delivered = Vec::with_capacity(input.len());
    for part in &input {
        let Some(stored) = stored_path(part) else {
            delivered.push(part.clone());
            continue;
        };
        let source = resolve_attachment_path(&ctx.config.data_dir, &thread.project_id, stored)?;
        let Some(root) = &root else {
            delivered.push(with_path(part, &source.to_string_lossy()));
            continue;
        };
        let name = Path::new(stored).file_name().map(|name| name.to_string_lossy().into_owned());
        let path = format!("{root}/{}/attachments/{}", thread.id, name.unwrap_or_default());
        copy_to_host(runner, &source, &path).await?;
        delivered.push(with_path(part, &path));
    }
    Ok(delivered)
}

#[cfg(test)]
mod tests {
    use super::path_looks_runtime_readable;

    #[test]
    fn runtime_readable_paths() {
        for path in ["/a", "\\a", "C:\\x", "https://x", "a+b.c-d:"] {
            assert!(path_looks_runtime_readable(path), "{path}");
        }
        for path in ["a.png", "dir/a.png", "1a:", ":x", "", "a b:"] {
            assert!(!path_looks_runtime_readable(path), "{path}");
        }
    }
}
